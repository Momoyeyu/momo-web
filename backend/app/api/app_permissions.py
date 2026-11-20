from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..core.desktop_auth import valid
from ..core.plugin_host import HostError
from ..services.app_permissions import (
    DesktopOperation, DesktopPermissionError, SystemPermission, denied_system_permissions,
    missing_system_permissions, native_desktop, permissions, read_system_permissions,
)
from ..services.computer import computer
from ..services.coordinator import runtime
from ..services.native_control import native_control

router = APIRouter(prefix='/api/computer/access')


class Consent(BaseModel):
    granted: bool


class Block(BaseModel):
    bundleId: str = Field(min_length=1, max_length=200)
    name: str = Field(default='', max_length=120)
    blocked: bool


class PermissionPrecheck(BaseModel):
    operation: DesktopOperation


class PermissionPrecheckResult(BaseModel):
    missing: list[SystemPermission]


def require_desktop(request):
    if not native_desktop() or request.headers.get('origin') != 'momo://app' or not valid(request.headers.get('x-momo-token')):
        raise HTTPException(403, 'Local desktop required')


def system_permission_detail(error):
    missing = denied_system_permissions(error)
    if missing:
        return {'code': 'permission_required', 'missing': missing}


def invalidate_activity(changed):
    if changed:
        computer.stop('permission-changed')
        try:
            native_control.stop('permission-changed')
        except Exception:
            return {**permissions.status(), 'stopUnconfirmed': True}
    return permissions.status()


@router.get('')
def status(request: Request):
    if not native_desktop():
        return {'available': False}
    require_desktop(request)
    return {'available': True, **permissions.status()}


@router.put('/consent')
def consent(body: Consent, request: Request):
    require_desktop(request)
    return invalidate_activity(permissions.consent(body.granted))


@router.put('/blocklist')
def block(body: Block, request: Request):
    require_desktop(request)
    try:
        return invalidate_activity(permissions.block(body.bundleId, body.name, body.blocked))
    except DesktopPermissionError as error:
        raise HTTPException(409, str(error)) from None


@router.get('/system')
def system(request: Request):
    require_desktop(request)
    if not runtime.host:
        raise HTTPException(409, 'Application executor unavailable')
    return read_system_permissions(runtime.host)


@router.post('/precheck')
def precheck(body: PermissionPrecheck, request: Request) -> PermissionPrecheckResult:
    require_desktop(request)
    try:
        missing = missing_system_permissions(body.operation, read_system_permissions(runtime.host))
    except HostError:
        raise HTTPException(409, 'Application permission status unavailable') from None
    return PermissionPrecheckResult(missing=missing)


@router.post('/system/{kind}')
def request_system(kind: Literal['screen', 'input'], request: Request):
    require_desktop(request)
    if not runtime.host:
        raise HTTPException(409, 'Application executor unavailable')
    try:
        return runtime.host.request('native.permissions', {'kind': kind})
    except Exception:
        raise HTTPException(409, 'Open System Settings to finish granting access') from None
