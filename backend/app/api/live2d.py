"""Same-origin runtime loading avoids browser-only CDN connection failures."""
import httpx
from fastapi import APIRouter, HTTPException, Response
from ..services import live2d

router = APIRouter()


@router.get('/api/live2d/core')
def cubism_core() -> Response:
    try:
        return Response(live2d.runtime(), media_type='application/javascript',
                        headers={'Cache-Control': 'public, max-age=86400'})
    except (httpx.HTTPError, OSError, ValueError) as error:
        raise HTTPException(502, 'Cubism runtime could not be loaded. Verify bundled resources.') from error
