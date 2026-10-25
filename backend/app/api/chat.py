"""POST /api/chat：SSE 端点（ReAct 编排在 services/turn.py）。

事件格式：`data: {...}\n\n`，事件类型见 models.SseEvent。
成功回合末尾发 {"t":"done"}；失败发 {"t":"error"} 后直接结束（不发 done）。
"""

from __future__ import annotations

import json
import uuid
from typing import Iterator

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ConfigDict

from ..services import checkpoint, turn, onboarding
from ..models import SseEvent
from ..services.coordinator import runtime, CoordinationError, current_run

router = APIRouter()


class ControlIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=256)
    desc: str = Field(default="", max_length=500)
    label: str | None = Field(default=None, max_length=80)
    context: str | None = Field(default=None, max_length=500)
    duration: float | None = Field(default=None, gt=0, le=3600, allow_inf_nan=False)


class FaceIn(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    intensity: float = Field(default=0, ge=0, le=1, allow_inf_nan=False)


class PresentationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    avatarId: str = Field(max_length=128)
    revision: str = Field(max_length=128)
    expressions: list[ControlIn] = Field(max_length=128)
    motions: list[ControlIn] = Field(max_length=256)
    expressionState: FaceIn = Field(default_factory=FaceIn)


class ChatIn(BaseModel):
    text: str
    firstMeeting: bool = False
    presentation: PresentationIn | None = None
    clientId: str | None = Field(default=None, max_length=128)
    leaseId: str | None = Field(default=None, max_length=128)
    messageId: str | None = Field(default=None, max_length=128)


class InterruptIn(BaseModel):
    """打断回传：本回合的用户输入 + 用户实际看到的 assistant 文本（可空）。"""

    generation: int | None = Field(default=None, ge=0)
    user: str = ""
    assistant: str = ""
    runId: str | None = None
    clientId: str | None = None
    leaseId: str | None = None


def _sse(ev: SseEvent) -> str:
    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"


@router.post("/api/chat")
def chat(req: ChatIn) -> StreamingResponse:
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="empty text")
    try:
        runtime.require_meeting(req.clientId, req.leaseId)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error
    inbox = runtime.enqueue(
        "meeting", req.clientId or "local", req.messageId or uuid.uuid4().hex, req.text
    )
    if not inbox["acceptedNew"]:
        raise HTTPException(
            409,
            "This message was already accepted; reload history instead of resending",
        )

    def stream() -> Iterator[str]:
        errored = False
        iterator = None
        try:
            with runtime.run(inbox["run_id"], client=req.clientId, lease=req.leaseId):
                runtime.inbox_status(inbox["id"], "processing")
                iterator = iter(
                    turn.run_turn(
                        req.text,
                        req.presentation.model_dump() if req.presentation else None,
                        first_meeting=req.firstMeeting,
                        run_id=inbox["run_id"],
                    )
                )
                while True:
                    # ASGI may resume this sync generator in a different context
                    # for each sentence. Bind only while executing one next().
                    token = current_run.set(inbox["run_id"])
                    try:
                        ev = next(iterator)
                    except StopIteration:
                        break
                    finally:
                        current_run.reset(token)
                    if ev["t"] == "error":
                        errored = True
                    yield _sse(ev)
        except Exception as e:  # 兜底：agent 未捕获的异常也走 error 事件
            errored = True
            yield _sse({"t": "error", "message": str(e), "service": "backend"})
        finally:
            if iterator is not None:
                iterator.close()
            runtime.inbox_status(inbox["id"], "failed" if errored else "generated")
        if not errored:
            yield _sse({"t": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/api/chat/interrupt", status_code=204)
def interrupt(req: InterruptIn) -> Response:
    """打断：作废在途回合的落账，并把 live 尾对修正为用户实际看到的部分。

    幂等且与回合写入无序敏感——无论打断先于/后于回合落账到达，
    最终后端记录 = 前端展示。
    """
    try:
        runtime.require_meeting(req.clientId, req.leaseId)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error
    generation = onboarding.interrupt(
        req.user, req.assistant, req.generation, run_id=req.runId
    )
    return Response(status_code=204, headers={"X-Momo-Generation": str(generation)})
