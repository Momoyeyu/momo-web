"""Local-user configuration for the two reviewed personal-account plugins."""
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..services.social import social, SocialError
from ..services.coordinator import runtime, CoordinationError

router = APIRouter(prefix="/api/social/accounts")
Provider = Literal["qq", "wechat"]


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
    endpoint: str | None = Field(default=None, max_length=2048)
    token: str | None = Field(default=None, max_length=4096, json_schema_extra={"writeOnly": True})
    permissions: PermissionIn | None = None
    allowlistEnabled: bool | None = None
    allowlist: list[ContactIn] | None = Field(default=None, max_length=200)


class OwnerChallengeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    peerId: str = Field(min_length=1, max_length=160)


class ReconcileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commandId: str = Field(min_length=1, max_length=160)
    outcome: Literal["completed", "failed", "closed_unknown"]


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


@router.put("/{provider}")
def save(provider: Provider, body: AccountIn):
    return call(lambda: social.put(provider, body.model_dump(exclude_none=True)))


@router.post("/{provider}/connect")
def connect(provider: Provider):
    return call(lambda: social.connect(provider))


@router.post("/{provider}/disconnect")
def disconnect(provider: Provider):
    return call(lambda: social.disconnect(provider))


@router.post("/{provider}/resume")
def resume(provider: Provider):
    return call(lambda: social.resume(provider))


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
