"""POST /api/chat：SSE 端点（ReAct 编排在 services/turn.py）。

事件格式：`data: {...}\n\n`，事件类型见 models.SseEvent。
成功回合末尾发 {"t":"done"}；失败发 {"t":"error"} 后直接结束（不发 done）。
"""

from __future__ import annotations

import json
import uuid
from typing import Iterator

from ..services.dialogue_input import DialogueInput
from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool
from anyio import CancelScope
from pydantic import BaseModel, Field, ConfigDict

from ..services import checkpoint, turn, onboarding, vision
from ..models import SseEvent
from ..services.coordinator import runtime, CoordinationError, current_run

async def _closing_stream(iterator):
    try:
        async for event in iterate_in_threadpool(iterator):
            yield event
    finally:
        # Closing Starlette's threadpool adapter does not close its sync source.
        # Release attention deterministically, including ASGI cancellation.
        with CancelScope(shield=True):
            await run_in_threadpool(iterator.close)


class ChatStreamingResponse(StreamingResponse):
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            with CancelScope(shield=True):
                await self.body_iterator.aclose()


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
    text: str = Field(default="", max_length=65536)
    images: list[str] = Field(default_factory=list, max_length=4)
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
    return _chat(req)


class ScreenReactionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    generation: int
    clientId: str
    leaseId: str
    messageId: str | None = Field(default=None, max_length=128)
    presentation: PresentationIn | None = None


@router.post("/api/chat/screen-reaction")
def screen_reaction(req: ScreenReactionIn) -> StreamingResponse:
    from ..services.computer import computer, ComputerError
    try:
        observation = computer.claim_reaction(req.generation, req.clientId, req.leaseId)
    except (ComputerError, CoordinationError, vision.VisionError) as error:
        raise HTTPException(409, str(error)) from error
    if observation is None:
        return StreamingResponse(iter([_sse({"t":"done", "suppressed":True})]), media_type="text/event-stream")
    return _chat(ChatIn(clientId=req.clientId, leaseId=req.leaseId, messageId=req.messageId, presentation=req.presentation), observation=observation)


def _chat(req: ChatIn, observation=None) -> StreamingResponse:
    if observation is None and not req.text.strip() and not req.images:
        raise HTTPException(status_code=400, detail="empty text")
    try:
        runtime.require_meeting(req.clientId, req.leaseId)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error
    try:
        if req.images:
            vision.require_enabled()
            vision.validate_ids(req.images, local=True)
    except vision.VisionError as error:
        raise HTTPException(400, str(error)) from error
    inbox = runtime.enqueue(
        "meeting", req.clientId or "local", req.messageId or uuid.uuid4().hex, req.text
    )
    if not inbox["acceptedNew"]:
        raise HTTPException(
            409,
            "This message was already accepted; reload history instead of resending",
        )

    try:
        if observation is None:
            runtime.prepare_local(req.clientId, req.leaseId)
    except CoordinationError as error:
        runtime.inbox_status(inbox["id"], "held_interrupt")
        raise HTTPException(409, str(error)) from error

    def stream() -> Iterator[str]:
        errored = False
        iterator = None
        presentation_token = None
        generation = None
        generated = False
        try:
            with runtime.run(inbox["run_id"], client=req.clientId, lease=req.leaseId):
                runtime.inbox_status(inbox["id"], "processing")
                observed = None
                if observation is not None:
                    from ..services.computer import computer
                    token = current_run.set(inbox["run_id"])
                    try:
                        observed = computer.stage_reaction(observation["generation"])
                    finally:
                        current_run.reset(token)
                iterator = iter(
                    turn.run_turn(
                        DialogueInput(req.text, req.images or []),
                        req.presentation.model_dump() if req.presentation else None,
                        first_meeting=req.firstMeeting,
                        run_id=inbox["run_id"],
                        observation=observed,
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
                    if observation is not None:
                        from ..services.computer import computer, ComputerError
                        with computer.lock:
                            computer.gate()
                            if (computer.generation != observation["generation"] or not computer.observing
                                    or not computer.proactive or not computer.reactions):
                                raise ComputerError("computer.revoked")
                    if ev["t"] == "error":
                        errored = True
                    if ev["t"] == "sentence" and ev.get("text"):
                        generation = ev["generation"]
                        presentation_token = runtime.present(inbox["run_id"], generation)
                        if presentation_token:
                            ev = {**ev, "presentationToken": presentation_token}
                    yield _sse(ev)
                generated = True
        except Exception as e:  # 兜底：agent 未捕获的异常也走 error 事件
            errored = True
            yield _sse({"t": "error", "message": str(e), "service": "backend"})
        finally:
            if iterator is not None:
                iterator.close()
            runtime.inbox_status(inbox["id"], "failed" if errored else "generated")
            if errored or not generated:
                with runtime.condition:
                    if runtime.presentation and runtime.presentation["runId"] == inbox["run_id"]:
                        runtime.presentation = None
                    runtime.interrupt_hold = False
                    runtime.condition.notify_all()
        if not errored:
            yield _sse({"t": "done", "runId": inbox["run_id"], "generation": generation, **({"presentationToken": presentation_token} if presentation_token else {})})

    return ChatStreamingResponse(_closing_stream(stream()), media_type="text/event-stream")


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
    with runtime.condition:
        if runtime.presentation and (req.runId is None or runtime.presentation["runId"] == req.runId):
            runtime.presentation = None
            runtime.interrupt_hold = False
            runtime.condition.notify_all()
        for token, item in list(runtime.paused_presentations.items()):
            if req.runId is None or item["runId"] == req.runId:
                runtime.paused_presentations.pop(token)
        runtime.condition.notify_all()
    generation = onboarding.interrupt(
        req.user, req.assistant, req.generation, run_id=req.runId
    )
    return Response(status_code=204, headers={"X-Momo-Generation": str(generation)})


@router.get("/api/chat/voice/{clip_id}")
def voice_clip(clip_id: str):
    from ..services.dialogue_input import voice_wav
    try:
        return Response(voice_wav(clip_id), media_type="audio/wav", headers={"Cache-Control": "no-store"})
    except ValueError:
        raise HTTPException(404, "unavailable") from None
