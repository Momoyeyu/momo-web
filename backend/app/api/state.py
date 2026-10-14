"""GET/PUT /api/state：整体读写 state.json。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Response

from .. import memory, store

router = APIRouter()


@router.get("/api/state")
def get_state() -> dict[str, Any]:
    """完整 state JSON；无任何数据返回 {}。"""
    return store.get_state()


@router.put("/api/state", status_code=204)
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
