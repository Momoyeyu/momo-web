from typing import Literal
from fastapi import APIRouter,HTTPException
from pydantic import BaseModel,Field
from ..services.native_control import native_control
router=APIRouter(prefix='/api/computer/native')
class Owner(BaseModel):
    clientId:str
    leaseId:str
    plugin:Literal['computer','browser']='computer'
class Start(Owner):
    windowId:int=Field(gt=0)
    ownerPid:int=Field(gt=0)
    permissions:list[Literal['observe','interact']]
def call(fn,*args):
    try:return fn(*args)
    except Exception:raise HTTPException(409,'Application unavailable or permission denied') from None
@router.post('/targets')
def targets(body:Owner):return call(native_control.targets,body.clientId,body.leaseId,body.plugin)
@router.get('/status')
def status():return native_control.status()
@router.post('/start')
def start(body:Start):return call(native_control.start,body.windowId,body.ownerPid,body.permissions,body.clientId,body.leaseId,body.plugin)
@router.post('/stop')
def stop():return call(native_control.stop)
@router.post('/frame')
def frame(body:Owner):return call(native_control.frame,body.clientId,body.leaseId)

class Resume(Owner):
    requestId: str = Field(min_length=1, max_length=128)
@router.post('/resume')
def resume(body:Resume):return call(native_control.resume,body.requestId,body.clientId,body.leaseId)
