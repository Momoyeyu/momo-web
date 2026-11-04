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
