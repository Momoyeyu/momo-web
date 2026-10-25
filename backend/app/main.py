"""FastAPI 入口：CORS（localhost vite）+ api/ 下各 router 挂载。

运行：uv run uvicorn app.main:app --port 7821
"""

from __future__ import annotations

from contextlib import asynccontextmanager
import os
from .core.desktop_auth import DesktopAuth, allowed_origins
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .services import memory, state as state_service, extend
from .core.state import load as load_state
from .services.coordinator import runtime
from .api import (
    resources,
    onboarding,
    live2d,
    asr,
    chat,
    checkpoints,
    extensions,
    memories,
    state,
    tts,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await __import__("asyncio").to_thread(runtime.start)
    try:
        state_service.migrate_legacy_services()
        await __import__("asyncio").to_thread(
            extend.configure, load_state()["settings"]["extensions"]
        )
        memory.schedule_index()
        yield
    finally:
        await __import__("asyncio").to_thread(runtime.close)
        memory.shutdown_index()
        from .core.mcp import hub

        hub.close()


app = FastAPI(title="momo-web backend", lifespan=lifespan)

# 本地开发：放行任意 localhost/127.0.0.1 端口（vite 默认 5173）
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(allowed_origins())
    if os.environ.get("MOMO_DESKTOP_TOKEN")
    else [],
    allow_origin_regex=None
    if os.environ.get("MOMO_DESKTOP_TOKEN")
    else r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Sample-Rate", "X-Momo-Generation"],
)

app.include_router(state.router)
app.include_router(memories.router)
app.include_router(checkpoints.router)
app.include_router(extensions.router)
app.include_router(chat.router)
app.include_router(asr.router)
app.include_router(tts.router)

app.include_router(live2d.router)

app.include_router(onboarding.router)
from .api import meeting

app.include_router(meeting.router)

app.include_router(resources.router)


@app.get("/api/health")
def health():
    return {"ok": True}


from .api import probe

app.include_router(probe.router)
from .api import archive

app.include_router(archive.router)

from .core.maintenance import DataMaintenance

app.add_middleware(
    DataMaintenance,
    barrier_factory=lambda: runtime.maintenance() if runtime.started else None,
)
app.add_middleware(DesktopAuth)
