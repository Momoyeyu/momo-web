from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, StrictBool
from ..services import activities
router = APIRouter(prefix='/api/extensions/activities')
class Update(BaseModel):
    id: Literal['computer','browser','minecraft']
    enabled: StrictBool
@router.get('')
def read(): return activities.snapshot()
@router.patch('')
def update(body: Update):
    try: return activities.set_enabled(body.id,body.enabled)
    except Exception:
        raise HTTPException(409,'Activity change could not complete; disabled grants remain revoked') from None
