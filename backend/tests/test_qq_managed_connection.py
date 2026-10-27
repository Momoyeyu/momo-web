import copy
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.coordinator import runtime
from app.services.social import SocialAccounts, SocialError, social


@pytest.fixture
def native_host(monkeypatch):
    native = {"provider": "qq", "status": "connected", "running": True, "connected": True,
              "actualSelfId": "10001", "attemptId": "076a3a21-f6a1-4fd8-8377-1b1b93479434",
              "error": None, "executorQuiescent": False, "qr": None}
    calls = []

    def request(method, params, timeout=None):
        calls.append((method, copy.deepcopy(params)))
        if method == "qq.runtime.status":
            return copy.deepcopy(native)
        if method == "channels.health":
            return {"actualSelfId": "10001", "status": "connected", "executorQuiescent": True, "capabilities": {"receive": True, "reply": True}}
        raise AssertionError(method)

    monkeypatch.setattr(runtime, "started", True)
    monkeypatch.setattr(runtime, "mode", "dormant")
    monkeypatch.setattr(runtime, "host", SimpleNamespace(request=request))
    monkeypatch.setattr(runtime, "_unresolved_commands", lambda: [])
    monkeypatch.setattr(runtime, "refresh_social_plugins", lambda: {})
    return native, calls


def test_explicit_managed_connection_binds_first_native_identity_without_granting_policy_or_boot(native_host):
    store = SocialAccounts()
    store.put("qq", {"permissions": {"receive": False, "reply": False}, "allowlistEnabled": True, "allowlist": []})
    account = store.connect("qq", transport="managed")
    assert account["transport"] == "managed"
    assert account["enabled"] is True
    assert account["expectedSelfId"] == "10001"
    assert account["permissions"]["receive"] is False
    assert account["permissions"]["reply"] is False
    assert account["allowlistEnabled"] is True
    assert account["allowlist"] == []
    assert account["ownerPeerId"] is None
    assert runtime.mode == "dormant"
    config = store.host_configs()[0]
    assert config["transport"] == "managed"
    assert config["expectedSelfId"] == "10001"
    assert "endpoint" not in config
    assert "credential" not in config


def test_managed_transport_preserves_existing_credentials_owner_proof_and_private_scope(native_host):
    store = SocialAccounts()
    store.put("qq", {"enabled": True, "accountId": "legacy-qq", "expectedSelfId": "10001", "endpoint": "ws://127.0.0.1:3001", "token": "private-legacy-token", "allowlist": [{"peerId": "20002"}], "allowlistEnabled": True})
    data = store._read()
    data["qq"].update({"ownerPeerId": "20002", "ownerChallenge": {"peerId": "20002", "hash": "opaque-proof", "expiresAt": 9999999999}})
    store._write(data)
    old = copy.deepcopy(data["qq"])
    account = store.connect("qq", transport="managed")
    saved = store._read()["qq"]
    for key in ("accountId", "expectedSelfId", "endpoint", "credentialRef", "ownerPeerId", "ownerChallenge", "permissions", "allowlist", "allowlistEnabled"):
        assert saved[key] == old[key]
    assert account["transport"] == "managed"
    assert account["policyRevision"] > old["policyRevision"]
    assert "private-legacy-token" not in str(account)
    assert "endpoint" not in store.host_configs()[0]
    assert "credential" not in store.host_configs()[0]


@pytest.mark.parametrize("native_change", [{"actualSelfId": "99999"}, {"connected": False, "status": "qr_pending", "actualSelfId": None}])
def test_native_mismatch_or_incomplete_auth_cannot_switch_a_working_legacy_account(native_host, native_change):
    native_host[0].update(native_change)
    store = SocialAccounts()
    store.put("qq", {"enabled": True, "accountId": "legacy-qq", "expectedSelfId": "10001", "endpoint": "ws://127.0.0.1:3001", "token": "private-legacy-token"})
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.connect("qq", transport="managed")
    assert store._path().read_bytes() == before
    assert store.get("qq")["transport"] == "external"


def test_native_enable_checks_settings_again_after_the_async_identity_query(native_host, monkeypatch):
    store = SocialAccounts()
    store.put("qq", {"expectedSelfId": "10001"})
    original = runtime.host.request

    def raced(method, params, timeout=None):
        result = original(method, params, timeout)
        if method == "qq.runtime.status":
            store.put("qq", {"expectedSelfId": "99999", "permissions": {"reply": False}})
        return result

    monkeypatch.setattr(runtime.host, "request", raced)
    with pytest.raises(SocialError):
        store.connect("qq", transport="managed")
    assert store.get("qq")["expectedSelfId"] == "99999"
    assert store.get("qq")["enabled"] is False


def test_explicit_api_transport_cannot_be_replaced_by_arbitrary_process_configuration(native_host):
    client = TestClient(app)
    response = client.post("/api/social/accounts/qq/connect", json={"transport": "managed"})
    assert response.status_code == 200
    assert response.json()["transport"] == "managed"
    assert response.json()["expectedSelfId"] == "10001"
    response = client.post("/api/social/accounts/qq/connect", json={"transport": "managed", "command": "/tmp/untrusted"})
    assert response.status_code == 422
    assert client.post("/api/social/accounts/qq/connect", json={"transport": "arbitrary"}).status_code == 422
    assert client.post("/api/social/accounts/qq/connect?transport=external", json={"transport": "managed"}).status_code == 400


def test_managed_permission_save_needs_no_legacy_endpoint_and_disable_is_immediate(native_host):
    store = SocialAccounts()
    store.connect("qq", transport="managed")
    account = store.put("qq", {"permissions": {"reply": False}, "allowlistEnabled": True})
    assert account["transport"] == "managed"
    assert account["enabled"] is True
    assert account["endpoint"] == ""
    assert store.disconnect("qq")["enabled"] is False
    assert not store.host_configs()


def test_unresolved_old_send_cannot_be_bypassed_by_managed_transport_switch(native_host, monkeypatch):
    store = SocialAccounts()
    store.put("qq", {"accountId": "qq-main", "expectedSelfId": "10001", "endpoint": "ws://127.0.0.1:3001"})
    monkeypatch.setattr(runtime, "_unresolved_commands", lambda: [{"payload": '{"params":{"accountId":"qq-main"}}'}])
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.connect("qq", transport="managed")
    assert store._path().read_bytes() == before


def test_failed_native_business_verification_disables_without_falling_back_to_legacy(native_host, monkeypatch):
    store = SocialAccounts()
    store.put("qq", {"expectedSelfId": "10001", "endpoint": "ws://127.0.0.1:3001", "token": "retained-legacy-token"})
    original = runtime.host.request

    def failed_transport(method, params, timeout=None):
        if method == "channels.health":
            return {"status": "disconnected", "actualSelfId": None}
        return original(method, params, timeout)

    monkeypatch.setattr(runtime.host, "request", failed_transport)
    with pytest.raises(SocialError, match="disabled"):
        store.connect("qq", transport="managed")
    account = store.get("qq")
    assert account["transport"] == "managed"
    assert account["enabled"] is False
    assert account["endpoint"] == "ws://127.0.0.1:3001"
    assert account["hasCredential"] is True
    assert not store.host_configs()


def test_generic_account_save_cannot_enable_disconnected_managed_business(native_host):
    store = SocialAccounts()
    store.connect("qq", transport="managed")
    store.disconnect("qq")
    native_host[0].update({"status": "disconnected", "connected": False, "actualSelfId": None})
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.put("qq", {"enabled": True})
    assert store._path().read_bytes() == before
