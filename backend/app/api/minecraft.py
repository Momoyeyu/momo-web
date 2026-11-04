from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ..services.minecraft import minecraft, MinecraftError
from ..services.coordinator import CoordinationError
from ..services.vision import VisionError
from ..core.plugin_host import HostError

router = APIRouter(prefix='/api/minecraft')
def invoke(fn, *args):
    try: return fn(*args)
    except (MinecraftError, CoordinationError, VisionError, HostError) as error:
        raise HTTPException(409, str(error)) from error
class Owner(BaseModel):
    clientId: str
    leaseId: str
class Connect(Owner):
    port: int = Field(default=17643, ge=1024, le=65535)
    token: str = Field(min_length=32,max_length=512)
    world: str = Field(min_length=1,max_length=300)
    account: str = Field(min_length=1,max_length=100)
    permissions: list[Literal['game.observe','game.chat','game.move']]
class Action(Owner):
    generation: int
    action: Literal['observe','chat','follow']
    text: str = Field(default='', max_length=256)
    player: str = Field(default='', max_length=16)
    durationMs: int = Field(default=500,ge=1,le=1000)
@router.get('/status')
def status(): return invoke(minecraft.status)
@router.post('/connect')
def connect(body: Connect): return invoke(minecraft.connect,body.port,body.token,body.world,body.account,body.permissions,body.clientId,body.leaseId)
@router.post('/stop')
def stop(): return invoke(minecraft.stop)
@router.post('/actions')
def action(body: Action):
    args = {'text':body.text} if body.action == 'chat' else {'player':body.player,'durationMs':body.durationMs} if body.action == 'follow' else {}
    return invoke(minecraft.execute,body.action,args,body.generation,body.clientId,body.leaseId)

# Managed UI flow: public device code and profile only; tokens remain private.
from ..services import minecraft_managed as managed

def managed_call(fn, *args):
    try: return fn(*args)
    except (ValueError, OSError, KeyError, CoordinationError, VisionError, HostError):
        raise HTTPException(409, 'Minecraft account, resource or runtime operation could not complete') from None

class Login(BaseModel):
    clientId: str = Field(min_length=36,max_length=36)
class Prepare(BaseModel):
    resources: str | None = Field(default=None,min_length=1,max_length=2000)
class ManagedStart(Owner):
    server: str = Field(min_length=1,max_length=253)
    world: str = Field(min_length=1,max_length=200)
    permissions: list[Literal['game.observe','game.chat','game.move']]

@router.get('/managed/status')
def managed_status(): return managed_call(managed.status)
@router.post('/auth/begin')
def auth_begin(body: Login): return managed_call(managed.begin,body.clientId)
@router.post('/auth/poll')
def auth_poll(): return managed_call(managed.poll)
@router.post('/auth/logout')
def auth_logout(): return managed_call(managed.logout)
@router.post('/managed/prepare')
def managed_prepare(body: Prepare): return managed_call(managed.prepare,body.resources)
@router.post('/managed/start')
def managed_start(body: ManagedStart): return managed_call(managed.start,body.server,body.world,body.permissions,body.clientId,body.leaseId)
@router.post('/managed/stop')
def managed_stop(): return managed_call(managed.stop)
