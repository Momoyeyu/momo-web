from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ..services.browser import browser, BrowserError
from ..services.coordinator import CoordinationError
from ..services.vision import VisionError
from ..core.plugin_host import HostError
from ..services.browser_fetch import FetchError
router = APIRouter(prefix='/api/browser')
def invoke(fn,*args):
    try: return fn(*args)
    except (BrowserError,CoordinationError,VisionError,HostError,FetchError) as error: raise HTTPException(409,str(error)) from error
class Owner(BaseModel):
    clientId: str
    leaseId: str
class Start(Owner):
    permissions: list[Literal['observe','interact']] = ['observe']
    allowedHosts: list[str] = Field(default_factory=list,max_length=20)
class Action(Owner):
    generation: int
    version: int | None = None
    action: Literal['observe','load','click','type','scroll']
    html: str = Field(default='',max_length=100000)
    x: float = Field(default=0,ge=0,lt=1024)
    y: float = Field(default=0,ge=0,lt=768)
    text: str = Field(default='',max_length=1000)
    delta: int = Field(default=0,ge=-768,le=768)
@router.get('/status')
def status(): return invoke(browser.status)
@router.post('/start')
def start(body: Start): return invoke(browser.start,body.permissions,body.clientId,body.leaseId,body.allowedHosts)
@router.post('/stop')
def stop(): return invoke(browser.stop)
@router.post('/actions')
def action(body: Action):
    command = body.model_dump(exclude={'generation','version','clientId','leaseId'})
    return invoke(browser.execute,command,body.version,body.generation,body.clientId,body.leaseId)

class Open(Owner):
    generation: int
    url: str = Field(min_length=1,max_length=4096)
@router.post('/open')
def open_page(body: Open): return invoke(browser.open,body.url,body.generation,body.clientId,body.leaseId)
