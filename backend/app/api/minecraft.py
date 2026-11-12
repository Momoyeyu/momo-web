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
    permissions: list[Literal['game.observe','game.chat','game.move','game.modify']]
class Action(Owner):
    generation: int
    action: Literal['observe','chat','follow','play']
    text: str = Field(default='', max_length=256)
    held: list[Literal['forward','back','left','right','jump','sneak','sprint']] = Field(default_factory=list,max_length=7)
    x: float = Field(default=0.5,ge=0,le=1)
    y: float = Field(default=0.5,ge=0,le=1)
    scroll: float = Field(default=0,ge=-10,le=10)
    key: Literal['enter','backspace','tab','left','right','up','down'] = 'enter'
    control: Literal['aim','respawn','screenClick','screenScroll','screenText','screenKey','resume','forward','back','left','right','jump','sneak','sprint','look','attack','mine','use','eat','hotbar','inventory','close','slot','quickMove','drop','swapHands'] | None = None
    blockIndex: int = Field(default=0,ge=0,le=7)
    yaw: float = Field(default=0,ge=-180,le=180)
    pitch: float = Field(default=0,ge=-90,le=90)
    slot: int = Field(default=0,ge=0,le=255)
    button: int = Field(default=0,ge=0,le=1)
    player: str = Field(default='', max_length=16)
    durationMs: int = Field(default=500,ge=1,le=10000)
@router.get('/status')
def status(): return invoke(minecraft.status)
@router.post('/connect')
def connect(body: Connect): return invoke(minecraft.connect,body.port,body.token,body.world,body.account,body.permissions,body.clientId,body.leaseId)
@router.post('/stop')
def stop(): return invoke(minecraft.stop)
@router.post('/actions')
def action(body: Action):
    args = {'text':body.text} if body.action == 'chat' else {'player':body.player,'durationMs':body.durationMs} if body.action == 'follow' else {}
    if body.action=='play': args=body.model_dump(include={'control','blockIndex','held','text','x','y','scroll','key','durationMs','yaw','pitch','slot','button'})
    return invoke(minecraft.execute,body.action,args,body.generation,body.clientId,body.leaseId)


from ..services import minecraft_attach
class Attach(Owner):
    sessionId: str
    world: str
    account: str
    permissions: list[Literal['game.observe','game.chat','game.move','game.modify']]
class Install(BaseModel):
    instancePath: str
@router.get('/sessions')
def sessions(): return invoke(minecraft_attach.sessions)
@router.post('/attach')
def attach(body: Attach): return invoke(minecraft_attach.attach,body.sessionId,body.world,body.account,body.permissions,body.clientId,body.leaseId)
@router.post('/install')
def install(body: Install): return invoke(minecraft_attach.install,body.instancePath)
