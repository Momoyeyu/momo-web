"""/api/checkpoints：会话存档槽位 REST（Save/Load），模式同 /api/memories。"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from ..services import checkpoint
from ..models import (
    CheckpointCreated,
    CheckpointDetail,
    CheckpointMeta,
    LiveTranscript,
)

router = APIRouter()


def _raise_http(e: checkpoint.CheckpointError) -> None:
    code = {"not_found": 404, "conflict": 409}.get(e.kind, 400)
    raise HTTPException(status_code=code, detail=str(e))


class CheckpointIn(BaseModel):
    title: str | None = None
    slot: int | None = None


@router.get("/api/checkpoints")
def list_checkpoints() -> list[CheckpointMeta]:
    """存档槽列表（auto 置顶 + 手动按 slot 排序；preview=末条消息截断）。"""
    return checkpoint.list_checkpoints()


@router.post("/api/checkpoints", status_code=201)
def create_checkpoint(body: CheckpointIn | None = None) -> CheckpointCreated:
    """快照当前会话新建存档；slot 指定空槽，未指定取最小编号空槽。"""
    try:
        entry = checkpoint.create_checkpoint(
            body.title if body else None, body.slot if body else None
        )
    except checkpoint.CheckpointError as e:
        _raise_http(e)
    return {"id": entry["id"], "slot": entry["slot"]}


@router.get("/api/checkpoints/live")
def live_transcript() -> LiveTranscript:
    """当前会话（live 行）全文：前端启动时恢复字幕/backlog 用。"""
    return {
        "summary": checkpoint.live_summary(),
        "messages": checkpoint.live_messages(),
    }


@router.get("/api/checkpoints/{sid}")
def get_checkpoint(sid: str) -> CheckpointDetail:
    """存档全文（含 messages）。"""
    try:
        return checkpoint.get_checkpoint(sid)
    except checkpoint.CheckpointError as e:
        _raise_http(e)


@router.put("/api/checkpoints/{sid}")
def overwrite_checkpoint(
    sid: str, body: CheckpointIn | None = None
) -> CheckpointMeta:
    """重命名 + 用当前会话内容覆盖该槽。"""
    try:
        return checkpoint.meta(
            checkpoint.overwrite_checkpoint(sid, body.title if body else None)
        )
    except checkpoint.CheckpointError as e:
        _raise_http(e)


@router.delete("/api/checkpoints/{sid}", status_code=204)
def delete_checkpoint(sid: str) -> Response:
    try:
        checkpoint.delete_checkpoint(sid)
    except checkpoint.CheckpointError as e:
        _raise_http(e)
    return Response(status_code=204)


@router.post("/api/checkpoints/live/new", status_code=204)
def new_session() -> Response:
    """开启新会话：live 非空先快照进 auto 槽，然后清空 live。"""
    checkpoint.new_session()
    return Response(status_code=204)


@router.post("/api/checkpoints/{sid}/load")
def load_checkpoint(sid: str) -> CheckpointDetail:
    """加载存档覆盖当前会话（当前内容先进 auto 槽）。返回存档全文。"""
    try:
        return checkpoint.load_checkpoint(sid)
    except checkpoint.CheckpointError as e:
        _raise_http(e)
