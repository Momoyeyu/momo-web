"""FastAPI 入口：CORS（localhost vite）+ 路由挂载 + state/记忆 REST。

运行：uv run uvicorn app.main:app --port 7821
"""
from __future__ import annotations

from typing import Any

from fastapi import Body, FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import memory, store
from .chat import router as chat_router

app = FastAPI(title="momo-web backend")

# 本地开发：放行任意 localhost/127.0.0.1 端口（vite 默认 5173）
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_router)


def _pins() -> list[str]:
    pins = store.get_state().get("pins")
    if not isinstance(pins, list):
        return []
    return [p for p in pins if isinstance(p, str)]


def _raise_http(e: memory.MemoryError) -> None:
    """MemoryError.kind → HTTP 状态码。"""
    code = {"duplicate": 409, "not_found": 404}.get(e.kind, 400)
    raise HTTPException(status_code=code, detail=str(e))


# ---------- state ----------

@app.get("/api/state")
def get_state() -> dict[str, Any]:
    """完整 state JSON；无任何数据返回 {}。"""
    return store.get_state()


@app.put("/api/state", status_code=204)
def put_state(payload: dict[str, Any] = Body(...)) -> Response:
    """整体替换 state。旧版 memories 数组一次性导入普通记忆；
    旧版 user 对象忽略（前端已迁移为 pins）；两者均不落回 state.json。"""
    data = dict(payload)
    legacy_memories = data.pop("memories", None)
    data.pop("user", None)
    if isinstance(legacy_memories, list):
        memory.import_legacy(legacy_memories)
    store.write_state(data)
    return Response(status_code=204)


# ---------- 记忆 REST ----------

class MemoryIn(BaseModel):
    content: str


@app.get("/api/memories")
def list_memories() -> list[dict[str, Any]]:
    return memory.list_memories()


@app.post("/api/memories", status_code=201)
def create_memory(body: MemoryIn) -> dict[str, Any]:
    try:
        mem = memory.add_memory(body.content, pins=_pins())
    except memory.MemoryError as e:
        _raise_http(e)
    return {"id": mem["id"]}


@app.patch("/api/memories/{mem_id}")
def update_memory(mem_id: str, body: MemoryIn) -> dict[str, Any]:
    try:
        return memory.edit_memory(mem_id, body.content, pins=_pins())
    except memory.MemoryError as e:
        _raise_http(e)


@app.delete("/api/memories/{mem_id}", status_code=204)
def delete_memory(mem_id: str) -> Response:
    try:
        memory.delete_memory(mem_id)
    except memory.MemoryError as e:
        _raise_http(e)
    return Response(status_code=204)
