"""First-meeting status and scripted opening; no reset endpoint."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from .chat import PresentationIn, _sse
from ..services import onboarding

router = APIRouter()

class OpeningIn(BaseModel):
    presentation: PresentationIn | None = None

@router.get('/api/onboarding')
def status():
    return onboarding.status()

@router.post('/api/onboarding/opening')
def opening(req: OpeningIn):
    try:
        events = onboarding.opening(req.presentation.model_dump() if req.presentation else None)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return StreamingResponse(iter([*(_sse(e) for e in events), _sse({'t': 'done'})]), media_type='text/event-stream')
