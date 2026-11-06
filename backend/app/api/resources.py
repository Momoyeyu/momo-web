"""Read-only diagnostics for built-in capabilities, never endpoint configuration."""
from fastapi import APIRouter
from ..services import resources

router = APIRouter()

@router.get('/api/resources/status')
def resources_status() -> dict:
    return resources.status()
