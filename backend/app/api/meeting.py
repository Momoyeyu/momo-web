"""Attention is owned by a server lease; navigation never implicitly releases it."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ..services.coordinator import runtime, CoordinationError
from ..services import checkpoint, memory

router = APIRouter()


class LeaseIn(BaseModel):
    clientId: str = Field(min_length=8, max_length=128)
    leaseId: str | None = Field(default=None, max_length=128)
    restore: bool = False


def require(client, lease):
    try:
        runtime.require_meeting(client, lease)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error


@router.post("/api/meeting/enter")
def enter(body: LeaseIn):
    try:
        return runtime.enter(body.clientId, body.leaseId, restore=body.restore)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error


@router.post("/api/meeting/heartbeat")
def heartbeat(body: LeaseIn):
    try:
        return runtime.heartbeat(body.clientId, body.leaseId)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error


@router.post("/api/meeting/leave")
def leave(body: LeaseIn):
    try:
        runtime.leave(body.clientId, body.leaseId)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error
    return {"ok": True}


@router.get("/api/meeting")
def status():
    return runtime.snapshot()


class AckIn(BaseModel):
    runId: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=0)
    text: str = Field(max_length=128000)
    clientId: str | None = None
    leaseId: str | None = None


@router.post("/api/life/ack")
def acknowledge(body: AckIn):
    require(body.clientId, body.leaseId)
    if not checkpoint.acknowledge(body.runId, body.text, body.generation, source="meeting"):
        raise HTTPException(409, "Displayed prefix belongs to a stale or unknown reply")
    memory.schedule_index()
    return {"ok": True}


class AttentionIn(LeaseIn):
    requestId: str = Field(min_length=1, max_length=128)
    action: str = Field(max_length=32)
    runId: str | None = Field(default=None, max_length=128)


@router.post("/api/meeting/control")
def control(body: AttentionIn):
    try:
        return runtime.control(body.clientId, body.leaseId, body.requestId, body.action, body.runId)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error


class PresentationAckIn(LeaseIn):
    runId: str = Field(min_length=1, max_length=128)
    token: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=0)
    outcome: str = Field(pattern="^(completed|stopped|resume)$")
    text: str = Field(default="", max_length=128000)


@router.post("/api/meeting/presentation")
def presentation(body: PresentationAckIn):
    require(body.clientId, body.leaseId)
    # Validate the owner-bound presentation before changing visible history.
    with runtime.condition:
        item = runtime.paused_presentations.get(body.token) if body.outcome == "resume" else runtime.presentation
        if not item or any(item.get(key) != value for key, value in {"runId": body.runId, "token": body.token, "generation": body.generation, "clientId": body.clientId, "leaseId": body.leaseId}.items()):
            raise HTTPException(409, "Presentation capability is stale")
        if body.outcome == "completed":
            full = item["text"] if item.get("kind") == "replay" else checkpoint.generated_reply(body.runId)
            if full != body.text:
                raise HTTPException(409, "Complete presentation must acknowledge the complete reply")
        if item.get("kind") != "replay" and body.outcome != "resume" and not checkpoint.acknowledge(body.runId, body.text, body.generation, source="meeting"):
            raise HTTPException(409, "Presentation text belongs to a stale reply")
        try:
            result = runtime.complete_presentation(body.clientId, body.leaseId, body.runId, body.token, body.generation, body.outcome)
        except CoordinationError as error:
            raise HTTPException(409, str(error)) from error
    memory.schedule_index()
    return result


class ReplayIn(LeaseIn):
    runId: str = Field(min_length=1, max_length=128)
    eventId: str = Field(min_length=1, max_length=128)


@router.post("/api/meeting/replay")
def replay(body: ReplayIn):
    try:
        return runtime.replay(body.clientId, body.leaseId, body.runId, body.eventId)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error
