"""GET/PUT /api/state：整体读写 state.json。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Response

from .. import memory, store

router = APIRouter()


# 已迁 momo.db 的顶层键：GET 剥离不回吐（前端 passthrough 不必再携带）。
_MIGRATED_KEYS = ("memories", "pins", "user", "history", "summary")


@router.get("/api/state")
def get_state() -> dict[str, Any]:
    """完整 state JSON（已迁 momo.db 的字段剥离）；无任何数据返回 {}。"""
    return {k: v for k, v in store.get_state().items() if k not in _MIGRATED_KEYS}


@router.put("/api/state", status_code=204)
def put_state(payload: dict[str, Any] = Body(...)) -> Response:
    """整体替换 state。旧版字段一次性导入后丢弃，不落回 state.json：
    memories 数组 → 普通记忆；pins 数组 → 初始记忆（pinned 行）；
    history/summary → live 会话已在 momo.db，PUT 里的旧副本直接忽略。"""
    data = dict(payload)
    legacy_memories = data.pop("memories", None)
    legacy_pins = data.pop("pins", None)
    for k in ("user", "history", "summary"):
        data.pop(k, None)
    if isinstance(legacy_memories, list):
        memory.import_legacy(legacy_memories)
    if isinstance(legacy_pins, list):
        memory.import_pins(legacy_pins)
    store.write_state(data)
    return Response(status_code=204)
