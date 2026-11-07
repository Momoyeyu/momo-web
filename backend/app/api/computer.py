from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field
from ..services.computer import computer, ComputerError
from ..services.vision import VisionError, MAX_BYTES
from ..services.coordinator import CoordinationError, runtime
from ..core.plugin_host import HostError
from ..core.llm import LlmError

router = APIRouter(prefix='/api/computer')

def invoke(fn, *args):
    try: return fn(*args)
    except (ComputerError, VisionError, CoordinationError, HostError, LlmError) as error:
        raise HTTPException(409, str(error)) from error

class Settings(BaseModel):
    proactive: bool = False
    reactions: bool = False
class Start(Settings):
    source: str = Field(min_length=1,max_length=200)
class Ask(BaseModel):
    question: str = Field(min_length=1,max_length=4000)
    generation: int
    clientId: str
    leaseId: str

@router.get('/status')
def status(): return computer.snapshot()
@router.post('/start')
def start(body: Start): return invoke(computer.start,body.source,body.proactive,body.reactions)
@router.post('/stop')
def stop():
    result = computer.stop()
    if runtime.host: invoke(runtime.host.request,'computer.stop')
    return result
@router.patch('/settings')
def settings(body: Settings):
    with computer.lock:
        computer.proactive,computer.reactions = body.proactive,body.reactions
        return computer.snapshot()
@router.post('/frames')
async def frames(generation: int = Form(...), file: UploadFile = File(...)):
    try:
        raw = await file.read(MAX_BYTES+1)
        from asyncio import to_thread
        return await to_thread(invoke,computer.capture,raw,generation)
    finally: await file.close()
@router.post('/ask')
def ask(body: Ask): raise HTTPException(410, "Use the main chat for screen questions")

class React(BaseModel):
    generation: int
    clientId: str
    leaseId: str

@router.post("/react")
def react(body: React): raise HTTPException(410, "Use /api/chat/screen-reaction for acknowledged conversation output")

class DesktopFrame(BaseModel):
    clientId: str
    leaseId: str

class DesktopObservation(DesktopFrame):
    enabled: bool

@router.post('/desktop/frame')
def desktop_frame(body: DesktopFrame):
    invoke(runtime.require_meeting,body.clientId,body.leaseId)
    return invoke(computer.desktop_frame)

@router.post('/desktop/observation')
def desktop_observation(body: DesktopObservation):
    invoke(runtime.require_meeting,body.clientId,body.leaseId)
    return computer.set_desktop_allowed(body.enabled)
