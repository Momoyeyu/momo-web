import asyncio
from contextlib import ExitStack
from fastapi import APIRouter, Request, HTTPException, Response
from ..services import archive
from ..services.coordinator import runtime
router = APIRouter()

@router.get('/api/data/export')
def export_data():
    try:
        return Response(archive.export_data(), media_type='application/zip', headers={'Content-Disposition': 'attachment; filename="momo-data.zip"', 'Cache-Control': 'no-store'})
    except ValueError as exc:
        raise HTTPException(400, str(exc))

@router.post('/api/data/import')
async def import_data(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > archive.LIMIT:
            raise HTTPException(413, 'Archive exceeds size limit')
    def restore():
        # Release the runtime barrier before the renderer gets success and reloads.
        with ExitStack() as stack:
            if runtime.started:
                try:
                    stack.enter_context(runtime.maintenance())
                except Exception:
                    raise HTTPException(409, 'Could not safely pause runtime for restore') from None
            try:
                archive.import_data(bytes(raw))
            except Exception:
                raise HTTPException(400, 'Invalid or incompatible data archive') from None

    await asyncio.to_thread(restore)
    return {'ok': True}

@router.post('/api/data/validate')
async def validate_data(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > archive.LIMIT:
            raise HTTPException(413, 'Archive exceeds size limit')
    try:
        archive.validate(bytes(raw))
    except Exception:
        raise HTTPException(400, 'Invalid or incompatible data archive')
    return {'ok': True}
