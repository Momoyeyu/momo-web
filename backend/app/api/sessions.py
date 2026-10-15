"""/api/sessions：会话存档槽位 REST（Save/Load），模式同 /api/memories。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from .. import session

router = APIRouter()


def _raise_http(e: session.SessionError) -> None:
    code = {"not_found": 404, "conflict": 409}.get(e.kind, 400)
    raise HTTPException(status_code=code, detail=str(e))


class SessionIn(BaseModel):
    title: str | None = None
    slot: int | None = None


@router.get("/api/sessions")
def list_sessions() -> list[dict[str, Any]]:
    """存档槽列表（auto 置顶 + 手动按 slot 排序；preview=末条消息截断）。"""
    return session.list_sessions()


@router.post("/api/sessions", status_code=201)
def create_session(body: SessionIn | None = None) -> dict[str, Any]:
    """快照当前会话新建存档；slot 指定空槽，未指定取最小编号空槽。"""
    try:
        entry = session.create_session(
            body.title if body else None, body.slot if body else None
        )
    except session.SessionError as e:
        _raise_http(e)
    return {"id": entry["id"], "slot": entry["slot"]}


@router.get("/api/sessions/{sid}")
def get_session(sid: str) -> dict[str, Any]:
    """存档全文（含 messages）。"""
    try:
        return session.get_session(sid)
    except session.SessionError as e:
        _raise_http(e)


@router.put("/api/sessions/{sid}")
def overwrite_session(sid: str, body: SessionIn | None = None) -> dict[str, Any]:
    """重命名 + 用当前会话内容覆盖该槽。"""
    try:
        return session.meta(
            session.overwrite_session(sid, body.title if body else None)
        )
    except session.SessionError as e:
        _raise_http(e)


@router.delete("/api/sessions/{sid}", status_code=204)
def delete_session(sid: str) -> Response:
    try:
        session.delete_session(sid)
    except session.SessionError as e:
        _raise_http(e)
    return Response(status_code=204)


@router.post("/api/sessions/{sid}/load")
def load_session(sid: str) -> dict[str, Any]:
    """加载存档覆盖当前会话（当前内容先进 auto 槽）。返回存档全文。"""
    try:
        return session.load_session(sid)
    except session.SessionError as e:
        _raise_http(e)
