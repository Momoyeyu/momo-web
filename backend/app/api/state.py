"""GET/PUT /api/state：整体读写 data/momo.yaml（HTTP 层载荷仍是 JSON）。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Response

from ..services import state

router = APIRouter()


@router.get("/api/state")
def get_state() -> dict[str, Any]:
    """完整 state JSON；无任何数据返回 {}。"""
    return state.read()


@router.put("/api/state", status_code=204)
def put_state(payload: dict[str, Any] = Body(...)) -> Response:
    """整体替换 state。"""
    state.replace(payload)
    return Response(status_code=204)
