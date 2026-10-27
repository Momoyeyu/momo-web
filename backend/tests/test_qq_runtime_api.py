"""Local account login has no authority to activate momo or grant messaging."""
import copy
import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.core.plugin_host import HostError
from app.main import app
from app.services.coordinator import runtime
from app.services.social import social


ATTEMPT = "076a3a21-f6a1-4fd8-8377-1b1b93479434"
PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="


def login_status(**values):
    return {"provider": "qq", "status": "qr_pending", "running": True,
            "connected": False, "actualSelfId": None, "attemptId": ATTEMPT,
            "error": None, "executorQuiescent": False,
            "qr": {"dataUrl": PNG, "expiresAt": int(time.time() * 1000) + 60000}, **values}


@pytest.fixture
def private_host(monkeypatch):
    calls = []
    response = login_status()

    def request(method, params=None, timeout=None):
        calls.append((method, copy.deepcopy(params), timeout))
        return copy.deepcopy(response)

    monkeypatch.setattr(runtime, "started", True)
    monkeypatch.setattr(runtime, "host", SimpleNamespace(request=request))
    monkeypatch.setattr(runtime, "mode", "dormant")
    return calls, response


def test_qr_is_authenticated_noncacheable_and_never_in_general_account_state(private_host, monkeypatch):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "local-owner-capability")
    client = TestClient(app)
    calls, _ = private_host
    assert client.get("/api/social/accounts/qq/runtime").status_code == 403
    assert not calls
    response = client.get("/api/social/accounts/qq/runtime", headers={"x-momo-token": "local-owner-capability"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["qr"]["dataUrl"] == PNG
    assert calls == [("qq.runtime.status", {"authenticatedDetail": True}, 3)]
    accounts = client.get("/api/social/accounts", headers={"x-momo-token": "local-owner-capability"})
    assert "data:image" not in accounts.text
    assert "qr_pending" not in accounts.text


def test_begin_pins_stored_identity_without_overwriting_account_or_boot(private_host, monkeypatch):
    monkeypatch.setattr(social, "_refresh", lambda: None)
    social.put("qq", {"accountId": "legacy-qq", "expectedSelfId": "10001",
                      "endpoint": "ws://127.0.0.1:3001", "token": "private-legacy-token",
                      "permissions": {"receive": False, "reply": False}})
    before = social._path().read_bytes()
    response = TestClient(app).post("/api/social/accounts/qq/runtime/begin", json={})
    assert response.status_code == 200
    assert private_host[0] == [("qq.runtime.begin", {"ownerAction": True, "expectedSelfId": "10001"}, 35)]
    assert social._path().read_bytes() == before
    assert runtime.mode == "dormant"
    assert social.get("qq")["enabled"] is False


def test_first_login_does_not_require_external_endpoint_or_enabled_plugin(private_host):
    response = TestClient(app).post("/api/social/accounts/qq/runtime/begin")
    assert response.status_code == 200
    assert private_host[0] == [("qq.runtime.begin", {"ownerAction": True, "expectedSelfId": None}, 35)]
    assert not social._path().exists()
    assert runtime.mode == "dormant"


@pytest.mark.parametrize("action", ["begin", "refresh", "cancel", "stop", "forget"])
def test_fixed_login_actions_reject_client_paths_commands_and_identity(action, private_host):
    client = TestClient(app)
    response = client.post(f"/api/social/accounts/qq/runtime/{action}", json={
        "expectedSelfId": "99999", "command": "/tmp/not-allowed", "endpoint": "https://example.com"})
    assert response.status_code == 422
    assert not private_host[0]
    response = client.post(f"/api/social/accounts/qq/runtime/{action}?expectedSelfId=99999")
    assert response.status_code == 400
    assert not private_host[0]


@pytest.mark.parametrize("action,timeout", [("refresh", 35), ("cancel", 20), ("stop", 20), ("forget", 20)])
def test_local_login_control_is_not_a_message_policy_update(action, timeout, private_host):
    response = TestClient(app).post(f"/api/social/accounts/qq/runtime/{action}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert private_host[0] == [(f"qq.runtime.{action}", {"ownerAction": True}, timeout)]
    assert runtime.mode == "dormant"
    assert not social._path().exists()


def test_raw_native_diagnostics_and_unrecognized_fields_never_reach_browser(private_host):
    private_host[1].update({"logs": "private account session key", "path": "/secret/runtime", "token": "secret-token"})
    response = TestClient(app).get("/api/social/accounts/qq/runtime")
    assert response.status_code == 200
    assert "private account" not in response.text
    assert "/secret" not in response.text
    assert "secret-token" not in response.text


@pytest.mark.parametrize("invalid", [
    {"running": "true"}, {"actualSelfId": "/private/session"}, {"status": "raw native log"},
    {"status": ["qr_pending"]}, {"running": True, "executorQuiescent": True},
    {"connected": True}, {"connected": True, "status": "connected", "actualSelfId": None},
    {"qr": {"dataUrl": "https://remote.example/qr", "expiresAt": 9999999999999}},
    {"qr": {"dataUrl": PNG, "expiresAt": True}},
])
def test_malformed_host_status_is_a_safe_noncacheable_failure(invalid, private_host):
    private_host[1].update(invalid)
    response = TestClient(app).get("/api/social/accounts/qq/runtime")
    assert response.status_code == 409
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["detail"]["code"] == "IPC_PROTOCOL"
    assert "private/session" not in response.text


@pytest.mark.parametrize("action", ["begin", "refresh", "cancel", "stop", "forget"])
def test_unauthenticated_login_control_never_reaches_native_host(action, private_host, monkeypatch):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "local-owner-capability")
    client = TestClient(app)
    response = client.post(f"/api/social/accounts/qq/runtime/{action}", json={})
    assert response.status_code == 403
    assert not private_host[0]
    response = client.post(f"/api/social/accounts/qq/runtime/{action}", json={}, headers={
        "x-momo-token": "local-owner-capability", "origin": "https://untrusted.example"})
    assert response.status_code == 403
    assert not private_host[0]


def test_qr_expires_before_browser_display_and_unknown_error_is_not_echoed(private_host):
    private_host[1].update({"qr": {"dataUrl": PNG, "expiresAt": 1}, "error": "private native session diagnostic"})
    response = TestClient(app).get("/api/social/accounts/qq/runtime")
    assert response.status_code == 200
    assert response.json()["qr"] is None
    assert response.json()["status"] == "expired"
    assert response.json()["error"] == "RUNTIME_FAILED"
    assert "private native" not in response.text


def test_host_failure_is_safe_and_does_not_disclose_runtime_paths(private_host, monkeypatch):
    def unavailable(*args, **kwargs):
        raise HostError("native library at /private/account/token-secret failed")
    monkeypatch.setattr(runtime.host, "request", unavailable)
    response = TestClient(app).post("/api/social/accounts/qq/runtime/begin")
    assert response.status_code == 409
    assert response.headers["cache-control"] == "no-store"
    assert response.json()["detail"]["code"] == "RUNTIME_UNAVAILABLE"
    assert "token-secret" not in response.text


def test_known_native_error_code_can_be_explained_without_its_diagnostics(private_host, monkeypatch):
    def unavailable(*args, **kwargs):
        raise HostError("RESOURCE_INVALID")
    monkeypatch.setattr(runtime.host, "request", unavailable)
    response = TestClient(app).post("/api/social/accounts/qq/runtime/begin")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "RESOURCE_INVALID"


def test_absent_host_does_not_start_coordinator_or_return_stale_qr(monkeypatch):
    monkeypatch.setattr(runtime, "started", False)
    monkeypatch.setattr(runtime, "host", None)
    response = TestClient(app).get("/api/social/accounts/qq/runtime")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "RUNTIME_UNAVAILABLE"
    assert runtime.started is False


def test_retired_provider_cannot_access_native_login_actions(private_host):
    client = TestClient(app)
    assert client.get("/api/social/accounts/wechat/runtime").status_code == 422
    assert client.post("/api/social/accounts/wechat/runtime/begin").status_code == 422
    assert not private_host[0]
