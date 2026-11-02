"""Locally authenticated image drafts and provider capability checks."""
from fastapi import APIRouter, File, UploadFile, HTTPException, Response
from .probe import Probe
from ..services import vision

router = APIRouter(prefix='/api/vision')

@router.post('/probe')
async def probe(cfg: Probe):
    return await vision.probe(cfg.model_dump())

@router.post('/capability')
def capability(cfg: Probe):
    values = cfg.model_dump()
    return {'verified':vision.verified(values)}

@router.get('/status')
def status():
    from ..services import state
    cfg = state.read().get('settings',{}).get('llm',{})
    return {'verified':vision.verified(cfg),'enabled':vision.enabled(cfg),'fingerprint':vision.fingerprint(cfg)}

@router.post('/images')
async def upload(file: UploadFile = File(...)):
    try:
        vision.require_enabled()
        raw = await file.read(vision.MAX_BYTES+1)
        vision.require_enabled()
        from asyncio import to_thread
        return await to_thread(vision.store, raw)
    except vision.VisionError as error:
        raise HTTPException(400,str(error)) from error
    finally:
        await file.close()

@router.get('/images/{image_id}')
def image(image_id: str):
    try:
        data, mime = vision.body(image_id)
        return Response(content=data,media_type=mime,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
    except vision.VisionError as error:
        raise HTTPException(404,str(error)) from error

@router.delete('/images/{image_id}',status_code=204)
def remove(image_id: str, forget: bool = False):
    try:
        (vision.remove_image if forget else vision.remove_draft)(image_id)
        return Response(status_code=204)
    except vision.VisionError as error:
        raise HTTPException(404,str(error)) from error
