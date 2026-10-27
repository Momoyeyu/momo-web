"""Local-user configuration for the reviewed QQ personal-account plugin."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from ..services.social import social, SocialError, QQRuntimeError
from ..services.coordinator import runtime, CoordinationError

router = APIRouter(prefix="/api/social/accounts")
Provider = Literal["qq"]


class PermissionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    receive: bool | None = None
    reply: bool | None = None
    proactive: bool | None = None
    contacts: bool | None = None
    history: bool | None = None


class ContactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    peerId: str = Field(min_length=1, max_length=160)
    label: str = Field(default="", max_length=160)


class AccountIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool | None = None
    accountId: str | None = Field(default=None, max_length=160)
    expectedSelfId: str | None = Field(default=None, max_length=160)
    permissions: PermissionIn | None = None
    allowlistEnabled: bool | None = None
    allowlist: list[ContactIn] | None = Field(default=None, max_length=200)


class ConnectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transport: Literal["managed"] | None = None


class OwnerChallengeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    peerId: str = Field(min_length=1, max_length=160)


class ReconcileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commandId: str = Field(min_length=1, max_length=160)
    outcome: Literal["completed", "failed", "closed_unknown"]


class RetiredWaitIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commandId: str = Field(min_length=1, max_length=160)
    executorStopped: StrictBool

    @field_validator("executorStopped")
    @classmethod
    def require_stop_confirmation(cls, value):
        if value is not True:
            raise ValueError("Confirm the retired executor was stopped first")
        return value


class RuntimeActionIn(BaseModel):
    """Actions accept no executable, path, identity, or transport input."""
    model_config = ConfigDict(extra="forbid")


class RuntimeQROut(BaseModel):
    dataUrl: str = Field(max_length=384 * 1024)
    expiresAt: int


class RuntimeStatusOut(BaseModel):
    provider: Literal["qq"]
    status: Literal["idle", "preparing", "connecting", "qr_pending", "awaiting_confirmation", "verifying",
                    "expired", "connected", "identity_mismatch", "cancelled", "stopping", "stopped",
                    "disconnected", "error"]
    running: bool
    connected: bool
    actualSelfId: str | None
    attemptId: str | None
    error: str | None
    executorQuiescent: bool
    qr: RuntimeQROut | None = None


def call(operation):
    try:
        return operation()
    except SocialError as error:
        raise HTTPException(400, str(error)) from error
    except CoordinationError as error:
        raise HTTPException(409, str(error)) from error


@router.get("")
def accounts():
    return call(social.list_accounts)


@router.get("/retired/records")
def retired_records():
    return call(runtime.retired_operations)


@router.post("/retired/end-wait")
def end_retired_wait(body: RetiredWaitIn):
    def apply():
        try:
            attention = runtime.end_retired_wait(body.commandId, executor_stopped=body.executorStopped)
        except ValueError as error:
            raise SocialError(str(error)) from error
        return {"ok": True, "records": runtime.retired_operations()["records"], "attention": attention}
    return call(apply)


@router.put("/{provider}")
def save(provider: Provider, body: AccountIn):
    return call(lambda: social.put(provider, body.model_dump(exclude_none=True)))


@router.post("/{provider}/connect")
def connect(provider: Provider, request: Request, body: ConnectIn | None = None):
    if request.query_params:
        raise HTTPException(400, "QQ connection actions do not accept query parameters")
    return call(lambda: social.connect(provider, transport=body.transport if body else None))


@router.post("/{provider}/disconnect")
def disconnect(provider: Provider):
    return call(lambda: social.disconnect(provider))


@router.post("/{provider}/resume")
def resume(provider: Provider):
    return call(lambda: social.resume(provider))


def runtime_call(request, response, action):
    # QR data is an ephemeral account credential and belongs only to the
    # normally authenticated local-user API, never public account/state output.
    headers = {"Cache-Control": "no-store"}
    response.headers.update(headers)
    if request.query_params:
        raise HTTPException(400, "QQ login actions do not accept query parameters", headers=headers)
    try:
        return social.managed_qq_runtime(action)
    except QQRuntimeError as error:
        raise HTTPException(409, {"code": error.code, "message": str(error)}, headers=headers) from None
    except SocialError:
        raise HTTPException(409, {"code": "RUNTIME_UNAVAILABLE", "message": "Managed QQ runtime is unavailable"}, headers=headers) from None


@router.get("/{provider}/runtime", response_model=RuntimeStatusOut)
def managed_runtime_status(provider: Provider, request: Request, response: Response):
    return runtime_call(request, response, "status")


@router.post("/{provider}/runtime/begin", response_model=RuntimeStatusOut)
def begin_runtime_login(provider: Provider, request: Request, response: Response, body: RuntimeActionIn | None = None):
    return runtime_call(request, response, "begin")


@router.post("/{provider}/runtime/refresh", response_model=RuntimeStatusOut)
def refresh_runtime_login(provider: Provider, request: Request, response: Response, body: RuntimeActionIn | None = None):
    return runtime_call(request, response, "refresh")


@router.post("/{provider}/runtime/cancel", response_model=RuntimeStatusOut)
def cancel_runtime_login(provider: Provider, request: Request, response: Response, body: RuntimeActionIn | None = None):
    return runtime_call(request, response, "cancel")


@router.post("/{provider}/runtime/stop", response_model=RuntimeStatusOut)
def stop_runtime(provider: Provider, request: Request, response: Response, body: RuntimeActionIn | None = None):
    return runtime_call(request, response, "stop")


@router.post("/{provider}/runtime/forget", response_model=RuntimeStatusOut)
def forget_runtime_session(provider: Provider, request: Request, response: Response, body: RuntimeActionIn | None = None):
    return runtime_call(request, response, "forget")


@router.post("/{provider}/owner-challenge")
def owner_challenge(provider: Provider, body: OwnerChallengeIn):
    return call(lambda: social.owner_challenge(provider, body.peerId))


@router.get("/{provider}/records")
def records(provider: Provider):
    return call(lambda: social.records(provider))


@router.post("/{provider}/reconcile")
def reconcile(provider: Provider, body: ReconcileIn):
    def apply():
        record = next((r for r in social.records(provider)["records"] if r["commandId"] == body.commandId), None)
        if not record or record["status"] != "unknown":
            raise SocialError("No matching unknown operation belongs to this account")
        if body.outcome == "closed_unknown":
            if record.get("executorQuiescent") is not True:
                raise CoordinationError("The account executor must be stopped before ending the wait")
        runtime.reconcile_command(body.commandId, body.outcome)
        attention = runtime.recover_attention()
        return {"ok": True, "records": social.records(provider)["records"], "attention": attention}
    return call(apply)
