"""FastAPI 入口：CORS（localhost vite）+ api/ 下各 router 挂载。

运行：uv run uvicorn app.main:app --port 7821
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import live2d, asr, chat, checkpoints, extensions, memories, state, tts

app = FastAPI(title="momo-web backend")

# 本地开发：放行任意 localhost/127.0.0.1 端口（vite 默认 5173）
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(state.router)
app.include_router(memories.router)
app.include_router(checkpoints.router)
app.include_router(extensions.router)
app.include_router(chat.router)
app.include_router(asr.router)
app.include_router(tts.router)

app.include_router(live2d.router)
