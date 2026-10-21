"""POST /api/chat：SSE 端点（ReAct 编排在 services/turn.py）。

事件格式：`data: {...}\n\n`，事件类型见 models.SseEvent。
成功回合末尾发 {"t":"done"}；失败发 {"t":"error"} 后直接结束（不发 done）。
"""
from __future__ import annotations

import json
from typing import Iterator

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ConfigDict

from ..services import checkpoint, turn
from ..models import SseEvent

router = APIRouter()


class ControlIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=256)
    desc: str = Field(default='', max_length=500)
    label: str | None = Field(default=None, max_length=80)
    context: str | None = Field(default=None, max_length=500)
    duration: float | None = Field(default=None, gt=0, le=3600, allow_inf_nan=False)


class FaceIn(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    intensity: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)


class PresentationIn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    avatarId: str = Field(max_length=128)
    revision: str = Field(max_length=128)
    expressions: list[ControlIn] = Field(max_length=128)
    motions: list[ControlIn] = Field(max_length=256)
    expressionState: FaceIn = Field(default_factory=FaceIn)


class ChatIn(BaseModel):
    text: str
    presentation: PresentationIn | None = None


class InterruptIn(BaseModel):
    """打断回传：本回合的用户输入 + 用户实际看到的 assistant 文本（可空）。"""

    user: str = ""
    assistant: str = ""


def _sse(ev: SseEvent) -> str:
    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"


@router.post("/api/chat")
def chat(req: ChatIn) -> StreamingResponse:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="empty text")

    def stream() -> Iterator[str]:
        errored = False
        try:
            for ev in turn.run_turn(req.text, req.presentation.model_dump() if req.presentation else None):
                if ev["t"] == "error":
                    errored = True
                yield _sse(ev)
        except Exception as e:  # 兜底：agent 未捕获的异常也走 error 事件
            errored = True
            yield _sse({"t": "error", "message": str(e), "service": "backend"})
        if not errored:
            yield _sse({"t": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/api/chat/interrupt", status_code=204)
def interrupt(req: InterruptIn) -> Response:
    """打断：作废在途回合的落账，并把 live 尾对修正为用户实际看到的部分。

    幂等且与回合写入无序敏感——无论打断先于/后于回合落账到达，
    最终后端记录 = 前端展示。
    """
    checkpoint.interrupt_turn(req.user, req.assistant)
    return Response(status_code=204)
