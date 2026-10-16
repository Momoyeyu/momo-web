"""/api/memories CRUD：长期记忆（含 pinned=初始记忆，设置页手动维护）。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..services import memory
from ..models import Memory, MemoryCreated

router = APIRouter()


def _raise_http(e: memory.MemoryError) -> None:
    """MemoryError.kind → HTTP 状态码。"""
    code = {"duplicate": 409, "not_found": 404}.get(e.kind, 400)
    raise HTTPException(status_code=code, detail=str(e))


class MemoryIn(BaseModel):
    content: str
    pinned: bool = False


class MemoryPatch(BaseModel):
    content: str | None = None
    pinned: bool | None = None


@router.get("/api/memories")
def list_memories() -> list[Memory]:
    """全部记忆（含 pinned 标记；前端统一列表、徽标区分）。"""
    return memory.list_memories()


@router.post("/api/memories", status_code=201)
def create_memory(body: MemoryIn) -> MemoryCreated:
    try:
        mem = memory.add_memory(body.content, pinned=body.pinned)
    except memory.MemoryError as e:
        _raise_http(e)
    return {"id": mem["id"], "pinned": mem["pinned"]}


@router.patch("/api/memories/{mem_id}")
def update_memory(mem_id: str, body: MemoryPatch) -> Memory:
    if body.content is None and body.pinned is None:
        raise HTTPException(status_code=400, detail="nothing to update")
    try:
        if body.pinned is not None:
            memory.set_pinned(mem_id, body.pinned)
        if body.content is not None:
            return memory.update_memory(mem_id, body.content)
        for mem in memory.list_memories():
            if mem["id"] == mem_id:
                return mem
        raise memory.MemoryError("记忆不存在", kind="not_found")
    except memory.MemoryError as e:
        _raise_http(e)


@router.delete("/api/memories/{mem_id}", status_code=204)
def delete_memory(mem_id: str) -> Response:
    try:
        memory.delete_memory(mem_id)
    except memory.MemoryError as e:
        _raise_http(e)
    return Response(status_code=204)
