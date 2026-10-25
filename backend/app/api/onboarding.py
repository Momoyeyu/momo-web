"""First-meeting status and scripted opening; no reset endpoint."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from .chat import PresentationIn, _sse
from ..services import onboarding
from ..services.coordinator import runtime, CoordinationError
import uuid

router = APIRouter()


class OpeningIn(BaseModel):
    presentation: PresentationIn | None = None
    clientId: str | None = None
    leaseId: str | None = None


@router.get("/api/onboarding")
def status():
    return onboarding.status()


@router.post("/api/onboarding/opening")
def opening(req: OpeningIn):
    try:
        runtime.require_meeting(req.clientId, req.leaseId)
    except CoordinationError as e:
        raise HTTPException(409, str(e)) from e
    try:
        with runtime.run(
            "opening:" + uuid.uuid4().hex, client=req.clientId, lease=req.leaseId
        ):
            events = onboarding.opening(
                req.presentation.model_dump() if req.presentation else None
            )
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return StreamingResponse(
        iter([*(_sse(e) for e in events), _sse({"t": "done"})]),
        media_type="text/event-stream",
    )
