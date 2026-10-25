"""Attention is owned by a server lease; navigation never implicitly releases it."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ..services.coordinator import runtime, CoordinationError
from ..services import checkpoint, memory

router = APIRouter()


class LeaseIn(BaseModel):
    clientId: str = Field(min_length=8, max_length=128)
    leaseId: str | None = Field(default=None, max_length=128)


def require(client, lease):
    try:
        runtime.require_meeting(client, lease)
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error


@router.post("/api/meeting/enter")
def enter(body: LeaseIn):
    try:
        return runtime.enter(body.clientId, body.leaseId)
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
    with runtime.condition:
        runtime._expire()
        return {
            "mode": runtime.mode,
            "epoch": runtime.epoch,
            "busy": bool(runtime.active),
        }


class AckIn(BaseModel):
    runId: str = Field(min_length=1, max_length=128)
    generation: int = Field(ge=0)
    text: str = Field(max_length=128000)
    clientId: str | None = None
    leaseId: str | None = None


@router.post("/api/life/ack")
def acknowledge(body: AckIn):
    require(body.clientId, body.leaseId)
    if not checkpoint.acknowledge(body.runId, body.text, body.generation):
        raise HTTPException(409, "Displayed prefix belongs to a stale or unknown reply")
    memory.schedule_index()
    return {"ok": True}
