"""First-run guidance uses existing settings; no reset or skip endpoint."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ..services import intro
from ..core.llm import LlmError
from .probe import Probe

router=APIRouter()
class LanguageIn(BaseModel):
    lang:str

@router.get('/api/intro')
def status():
    return intro.status()

@router.post('/api/intro/language')
def language(body:LanguageIn):
    try:return intro.confirm_language(body.lang)
    except ValueError as error:raise HTTPException(409,str(error)) from error

@router.post('/api/intro/verify')
def verify(body:Probe):
    try:return intro.verify(body.model_dump())
    except (ValueError,LlmError) as error:
        intro.invalidate_configuration(body.model_dump())
        # Provider errors can contain credentials or response bodies.
        raise HTTPException(409,'Model check failed; verify API address, key, model and tool-call support') from error

@router.post('/api/intro/finish')
def finish():
    try:return intro.finish()
    except ValueError as error:raise HTTPException(409,str(error)) from error


@router.post('/api/intro/tts')
def tts():
    try:return intro.complete_tts()
    except ValueError as error:raise HTTPException(409,str(error)) from error

@router.post('/api/intro/memory')
def memory():
    try:return intro.confirm_memory()
    except ValueError as error:raise HTTPException(409,str(error)) from error

@router.post('/api/intro/acknowledge')
def acknowledge():
    try:return intro.acknowledge()
    except ValueError as error:raise HTTPException(409,str(error)) from error
