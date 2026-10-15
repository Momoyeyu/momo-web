"""/api/memories CRUD：长期记忆（含 pinned=初始记忆，设置页手动维护）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .. import memory

router = APIRouter()


def _raise_http(e: memory.MemoryError) -> None:
    """MemoryError.kind → HTTP 状态码。"""
    code = {"duplicate": 409, "not_found": 404}.get(e.kind, 400)
    raise HTTPException(status_code=code, detail=str(e))


class MemoryIn(BaseModel):
    content: str
    pinned: bool = False


class MemoryPatch(BaseModel):
    content: str


@router.get("/api/memories")
def list_memories() -> list[dict[str, Any]]:
    """全部记忆（含 pinned 标记；前端按 pinned 拆「初始/普通」两个区块）。"""
    return memory.list_memories()


@router.post("/api/memories", status_code=201)
def create_memory(body: MemoryIn) -> dict[str, Any]:
    try:
        mem = memory.add_memory(body.content, pinned=body.pinned)
    except memory.MemoryError as e:
        _raise_http(e)
    return {"id": mem["id"], "pinned": mem["pinned"]}


@router.patch("/api/memories/{mem_id}")
def update_memory(mem_id: str, body: MemoryPatch) -> dict[str, Any]:
    try:
        return memory.edit_memory(mem_id, body.content)
    except memory.MemoryError as e:
        _raise_http(e)


@router.delete("/api/memories/{mem_id}", status_code=204)
def delete_memory(mem_id: str) -> Response:
    try:
        memory.delete_memory(mem_id)
    except memory.MemoryError as e:
        _raise_http(e)
    return Response(status_code=204)
