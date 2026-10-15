"""GET/PUT /api/state：整体读写 state.json。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Response

from .. import store

router = APIRouter()


@router.get("/api/state")
def get_state() -> dict[str, Any]:
    """完整 state JSON；无任何数据返回 {}。"""
    return store.get_state()


@router.put("/api/state", status_code=204)
def put_state(payload: dict[str, Any] = Body(...)) -> Response:
    """整体替换 state。"""
    store.write_state(payload)
    return Response(status_code=204)
