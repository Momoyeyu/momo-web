"""/api/memories CRUD：普通记忆（id/content/createdAt）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .. import memory, store

router = APIRouter()


def _pins() -> list[str]:
    pins = store.get_state().get("pins")
    if not isinstance(pins, list):
        return []
    return [p for p in pins if isinstance(p, str)]


def _raise_http(e: memory.MemoryError) -> None:
    """MemoryError.kind → HTTP 状态码。"""
    code = {"duplicate": 409, "not_found": 404}.get(e.kind, 400)
    raise HTTPException(status_code=code, detail=str(e))


class MemoryIn(BaseModel):
    content: str


@router.get("/api/memories")
def list_memories() -> list[dict[str, Any]]:
    return memory.list_memories()


@router.post("/api/memories", status_code=201)
def create_memory(body: MemoryIn) -> dict[str, Any]:
    try:
        mem = memory.add_memory(body.content, pins=_pins())
    except memory.MemoryError as e:
        _raise_http(e)
    return {"id": mem["id"]}


@router.patch("/api/memories/{mem_id}")
def update_memory(mem_id: str, body: MemoryIn) -> dict[str, Any]:
    try:
        return memory.edit_memory(mem_id, body.content, pins=_pins())
    except memory.MemoryError as e:
        _raise_http(e)


@router.delete("/api/memories/{mem_id}", status_code=204)
def delete_memory(mem_id: str) -> Response:
    try:
        memory.delete_memory(mem_id)
    except memory.MemoryError as e:
        _raise_http(e)
    return Response(status_code=204)
