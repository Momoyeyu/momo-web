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


def logged_out_status():
    return login_status(status="idle", running=False, connected=False, actualSelfId=None,
                        attemptId=None, executorQuiescent=True, qr=None)


def enabled_account():
    account = social._default("qq")
    account.update(enabled=True, expectedSelfId="10001", ownerPeerId="20002",
                   permissions={**account["permissions"], "reply": False},
                   allowlistEnabled=True, allowlist=[{"peerId": "20002", "label": "owner"}])
    social._write({"qq": account})
    return copy.deepcopy(account)


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
    social.put("qq", {"accountId": "qq-main", "expectedSelfId": "10001",
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


@pytest.mark.parametrize("action", ["begin", "status"])
def test_authenticated_native_login_binds_blank_identity_without_enabling_plugin(action, private_host):
    private_host[1].update(status="connected", connected=True, actualSelfId="10001", qr=None)
    response = (TestClient(app).get("/api/social/accounts/qq/runtime") if action == "status"
                else TestClient(app).post("/api/social/accounts/qq/runtime/begin"))
    assert response.status_code == 200
    saved = social._read()["qq"]
    assert saved["expectedSelfId"] == "10001"
    assert saved["enabled"] is False and saved["ownerPeerId"] is None
    assert saved["permissions"] == {"receive": True, "reply": True, "proactive": False, "contacts": False, "history": False}
    before = social._path().read_bytes()
    TestClient(app).get("/api/social/accounts/qq/runtime")
    assert social._path().read_bytes() == before
    TestClient(app).post("/api/social/accounts/qq/runtime/begin")
    assert private_host[0][-1] == ("qq.runtime.begin", {"ownerAction": True, "expectedSelfId": "10001"}, 35)
    assert social.native_restore_binding() is None
    assert runtime.mode == "dormant"


def test_verified_first_identity_binding_preserves_existing_scope_and_owner_metadata(private_host):
    account = social._default("qq")
    account.update(ownerPeerId="20002", permissions={**account["permissions"], "reply": False},
                   allowlistEnabled=True, allowlist=[{"peerId": "20002", "label": "owner"}])
    social._write({"qq": account})
    private_host[1].update(status="connected", connected=True, actualSelfId="10001", qr=None)
    response = TestClient(app).get("/api/social/accounts/qq/runtime")
    assert response.status_code == 200
    saved = social._read()["qq"]
    assert saved["expectedSelfId"] == "10001"
    for key in ("accountId", "enabled", "ownerPeerId", "permissions", "allowlistEnabled", "allowlist", "quarantined"):
        assert saved[key] == account[key]


def test_authenticated_native_status_never_rebinds_an_existing_different_identity(private_host):
    account = social._default("qq")
    account.update(expectedSelfId="20002", ownerPeerId="30003")
    social._write({"qq": account})
    before = social._path().read_bytes()
    private_host[1].update(status="connected", connected=True, actualSelfId="10001", qr=None)
    TestClient(app).get("/api/social/accounts/qq/runtime")
    assert social._path().read_bytes() == before


def test_connected_snapshot_without_a_live_attempt_cannot_create_an_identity_binding(private_host):
    private_host[1].update(status="connected", connected=True, actualSelfId="10001", attemptId=None, qr=None)
    TestClient(app).get("/api/social/accounts/qq/runtime")
    assert not social._path().exists()


def test_late_login_snapshot_cannot_bind_identity_after_logout(private_host, monkeypatch):
    ready = login_status(status="connected", connected=True, actualSelfId="10001", qr=None)

    def request(method, params=None, timeout=None):
        if method == "qq.runtime.status":
            social.managed_qq_runtime("forget")
            return ready
        assert method == "qq.runtime.forget"
        return logged_out_status()

    monkeypatch.setattr(runtime.host, "request", request)
    TestClient(app).get("/api/social/accounts/qq/runtime")
    assert not social._path().exists()


def test_late_login_from_a_replaced_host_cannot_create_an_identity_binding(private_host, monkeypatch):
    def request(method, params=None, timeout=None):
        monkeypatch.setattr(runtime, "host", SimpleNamespace(request=lambda *a, **k: logged_out_status()))
        return login_status(status="connected", connected=True, actualSelfId="10001", qr=None)

    monkeypatch.setattr(runtime.host, "request", request)
    TestClient(app).get("/api/social/accounts/qq/runtime")
    assert not social._path().exists()


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
    if action == "forget":
        private_host[1].update(logged_out_status())
    response = TestClient(app).post(f"/api/social/accounts/qq/runtime/{action}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert private_host[0] == [(f"qq.runtime.{action}", {"ownerAction": True}, timeout)]
    assert runtime.mode == "dormant"
    assert not social._path().exists()


def test_logout_disables_business_before_native_forget_without_waiting_for_mcp(private_host, monkeypatch):
    before = enabled_account()
    monkeypatch.setattr(runtime, "refresh_social_plugins", lambda: pytest.fail("logout must not wait for MCP"))

    def request(method, params=None, timeout=None):
        assert method == "qq.runtime.forget" and params == {"ownerAction": True}
        assert social._read()["qq"]["enabled"] is False
        assert social.native_restore_binding() is None
        assert social.host_configs() == []
        return logged_out_status()

    monkeypatch.setattr(runtime.host, "request", request)
    response = TestClient(app).post("/api/social/accounts/qq/runtime/forget")
    assert response.status_code == 200
    after = social._read()["qq"]
    assert after == {**before, "enabled": False, "policyRevision": before["policyRevision"] + 1}
    assert runtime.mode == "dormant"


@pytest.mark.parametrize("code", ["FORGET_FAILED", "RUNTIME_NOT_QUIESCENT"])
def test_logout_failure_is_visible_and_never_reenables_business(code, private_host, monkeypatch):
    before = enabled_account()

    def request(method, params=None, timeout=None):
        assert social._read()["qq"]["enabled"] is False
        raise HostError(code)

    monkeypatch.setattr(runtime.host, "request", request)
    response = TestClient(app).post("/api/social/accounts/qq/runtime/forget")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == code
    after = social._read()["qq"]
    assert after == {**before, "enabled": False, "policyRevision": before["policyRevision"] + 1}
    assert social.native_restore_binding() is None


def test_logout_with_unavailable_native_host_still_withdraws_business(private_host, monkeypatch):
    enabled_account()
    monkeypatch.setattr(runtime, "host", None)
    response = TestClient(app).post("/api/social/accounts/qq/runtime/forget")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "RUNTIME_UNAVAILABLE"
    assert social._read()["qq"]["enabled"] is False
    assert social.native_restore_binding() is None


def test_logout_cannot_report_success_while_native_runtime_is_still_connected(private_host):
    enabled_account()
    private_host[1].update(status="connected", connected=True, actualSelfId="10001", qr=None)
    response = TestClient(app).post("/api/social/accounts/qq/runtime/forget")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "IPC_PROTOCOL"
    assert social._read()["qq"]["enabled"] is False


def test_connect_cannot_start_during_logout(private_host, monkeypatch):
    from app.services.social import SocialError
    enabled_account()

    def request(method, params=None, timeout=None):
        assert method == "qq.runtime.forget"
        with pytest.raises(SocialError, match="logout"):
            social.connect("qq")
        return logged_out_status()

    monkeypatch.setattr(runtime.host, "request", request)
    response = TestClient(app).post("/api/social/accounts/qq/runtime/forget")
    assert response.status_code == 200
    assert social._read()["qq"]["enabled"] is False


def test_connect_verification_started_before_logout_cannot_commit_afterward(private_host, monkeypatch):
    from app.services.social import SocialError
    enabled_account()
    ready = login_status(status="connected", connected=True, actualSelfId="10001", qr=None)
    logout_started = False

    def request(method, params=None, timeout=None):
        nonlocal logout_started
        if method == "qq.runtime.status":
            logout_started = True
            social.managed_qq_runtime("forget")
            return ready
        if method == "channels.health":
            return {"actualSelfId": "10001", "status": "connected", "executorQuiescent": True}
        if method == "plugins.configure":
            return {}
        assert method == "qq.runtime.forget"
        return logged_out_status()

    monkeypatch.setattr(runtime.host, "request", request)
    monkeypatch.setattr(runtime, "_unresolved_commands", lambda: [])
    with pytest.raises(SocialError):
        social.connect("qq")
    assert logout_started
    assert social._read()["qq"]["enabled"] is False


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
