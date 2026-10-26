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
        attention_run = "opening:" + uuid.uuid4().hex
        with runtime.run(attention_run, client=req.clientId, lease=req.leaseId):
            events = onboarding.opening(req.presentation.model_dump() if req.presentation else None)
            first = next((e for e in events if e.get("t") == "sentence" and e.get("text")), None)
            presentation_token = runtime.present(attention_run, first["generation"], display_run_id=first["runId"]) if first else None
            if presentation_token:
                events = [{**event, "presentationToken": presentation_token} if event.get("t") == "sentence" else event for event in events]
            done = {"t": "done", **({"runId": first["runId"], "generation": first["generation"], "presentationToken": presentation_token} if first and presentation_token else {})}
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return StreamingResponse(
        iter([*(_sse(e) for e in events), _sse(done)]),
        media_type="text/event-stream",
    )
