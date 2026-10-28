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


def test_native_connection_preserves_owner_proof_and_private_scope(native_host):
    store = SocialAccounts()
    store.put("qq", {"accountId": "qq-main", "expectedSelfId": "10001", "allowlist": [{"peerId": "20002"}], "allowlistEnabled": True})
    data = store._read()
    data["qq"].update({"ownerPeerId": "20002", "ownerChallenge": {"peerId": "20002", "hash": "opaque-proof", "expiresAt": 9999999999}})
    store._write(data)
    old = copy.deepcopy(data["qq"])
    account = store.connect("qq", transport="managed")
    saved = store._read()["qq"]
    for key in ("accountId", "expectedSelfId", "ownerPeerId", "ownerChallenge", "permissions", "allowlist", "allowlistEnabled"):
        assert saved[key] == old[key]
    assert account["transport"] == "managed"
    assert account["policyRevision"] > old["policyRevision"]
    assert not {"endpoint", "token", "credentialRef", "hasCredential"}.intersection(account)
    assert "endpoint" not in store.host_configs()[0]
    assert "credential" not in store.host_configs()[0]


@pytest.mark.parametrize("native_change", [{"actualSelfId": "99999"}, {"connected": False, "status": "qr_pending", "actualSelfId": None}])
def test_native_mismatch_or_incomplete_auth_cannot_enable_the_account(native_host, native_change):
    native_host[0].update(native_change)
    store = SocialAccounts()
    store.put("qq", {"accountId": "qq-main", "expectedSelfId": "10001"})
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.connect("qq", transport="managed")
    assert store._path().read_bytes() == before
    assert store.get("qq")["enabled"] is False


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


@pytest.mark.parametrize("body", [{}, {"transport": "managed"}])
def test_native_api_connection_cannot_be_replaced_by_arbitrary_process_configuration(native_host, body):
    client = TestClient(app)
    response = client.post("/api/social/accounts/qq/connect", json=body)
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
    assert "endpoint" not in account
    assert store.disconnect("qq")["enabled"] is False
    assert not store.host_configs()


def test_unresolved_old_send_cannot_be_bypassed_by_managed_transport_switch(native_host, monkeypatch):
    store = SocialAccounts()
    store.put("qq", {"accountId": "qq-main", "expectedSelfId": "10001"})
    monkeypatch.setattr(runtime, "_unresolved_commands", lambda: [{"payload": '{"params":{"accountId":"qq-main"}}'}])
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.connect("qq", transport="managed")
    assert store._path().read_bytes() == before


def test_failed_native_business_verification_disables_the_account(native_host, monkeypatch):
    store = SocialAccounts()
    store.put("qq", {"expectedSelfId": "10001"})
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
    assert not {"endpoint", "token", "credentialRef", "hasCredential"}.intersection(account)
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


def quarantined_account(store):
    store.put("qq", {"expectedSelfId": "10001", "permissions": {"reply": False},
                     "allowlistEnabled": True, "allowlist": [{"peerId": "20002", "label": "friend"}]})
    data = store._read()
    data["qq"].update(enabled=False, quarantined=True, ownerPeerId="20002",
                       ownerChallenge={"peerId": "30003", "hash": "opaque-proof", "expiresAt": 9999999999})
    store._write(data)
    return copy.deepcopy(data["qq"])


def test_enable_automatically_releases_resolved_quarantine_with_native_health_and_preserves_scope(native_host):
    store = SocialAccounts()
    before = quarantined_account(store)
    account = store.connect("qq")
    assert account["enabled"] is True and account["quarantined"] is False
    after = store._read()["qq"]
    for key in ("accountId", "expectedSelfId", "ownerPeerId", "ownerChallenge", "permissions", "allowlist", "allowlistEnabled"):
        assert after[key] == before[key]
    assert account["status"] == "connected"
    assert runtime.mode == "dormant"
    assert [method for method, _ in native_host[1]] == ["qq.runtime.status", "channels.health"]


def test_enable_cannot_clear_quarantine_with_a_real_unknown_send(native_host, monkeypatch):
    from app.core import db
    runtime.schema()
    store = SocialAccounts()
    quarantined_account(store)
    payload = '{"method":"channels.send","accountId":"qq-main","pluginId":"momo-qq"}'
    with db.tx() as connection:
        connection.execute("INSERT INTO outbox(command_id,run_id,epoch,status,payload,at) VALUES(?,?,?,?,?,?)",
                           ("unknown-command", "old-turn", 1, "unknown", payload, db.now_iso()))
    monkeypatch.setattr(runtime, "_unresolved_commands", lambda: db.query("SELECT * FROM outbox WHERE status='unknown'"))
    before = store._path().read_bytes()
    with pytest.raises(SocialError, match="pending operation"):
        store.connect("qq")
    assert store._path().read_bytes() == before
    assert db.query("SELECT status FROM outbox WHERE command_id='unknown-command'")[0]["status"] == "unknown"
    assert not store.host_configs()


@pytest.mark.parametrize("native_change", [{"actualSelfId": "99999"},
    {"status": "disconnected", "connected": False, "actualSelfId": None}])
def test_enable_cannot_release_quarantine_without_verified_native_identity(native_host, native_change):
    store = SocialAccounts()
    quarantined_account(store)
    native_host[0].update(native_change)
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.connect("qq")
    assert store._path().read_bytes() == before


def test_failed_enable_verification_retains_previous_quarantine_and_disables_business(native_host, monkeypatch):
    store = SocialAccounts()
    before = quarantined_account(store)
    original = runtime.host.request

    def failed_health(method, params, timeout=None):
        if method == "channels.health":
            return {"status": "disconnected", "actualSelfId": None}
        return original(method, params, timeout)

    monkeypatch.setattr(runtime.host, "request", failed_health)
    with pytest.raises(SocialError, match="disabled"):
        store.connect("qq")
    after = store._read()["qq"]
    assert after["enabled"] is False and after["quarantined"] is True
    assert after["policyRevision"] > before["policyRevision"]
    assert after["ownerPeerId"] == "20002" and after["permissions"]["reply"] is False


def test_legacy_resume_cannot_bypass_fresh_native_admission(native_host):
    store = SocialAccounts()
    quarantined_account(store)
    native_host[0].update(status="disconnected", connected=False, actualSelfId=None)
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.resume("qq")
    assert store._path().read_bytes() == before


def test_permission_autosave_after_logout_does_not_reenable_or_change_owner_scope(native_host):
    from app.services.social import SocialError
    store = SocialAccounts()
    store.connect("qq")
    data = store._read()
    data["qq"]["ownerPeerId"] = "20002"
    store._write(data)
    store.disconnect("qq")
    before = store._read()["qq"]
    account = store.put("qq", {"permissions": {"reply": False}, "allowlistEnabled": True, "allowlist": []})
    assert account["enabled"] is False and account["ownerPeerId"] == "20002"
    assert account["expectedSelfId"] == before["expectedSelfId"]
    assert not store.host_configs()
    with pytest.raises(SocialError):
        store.put("qq", {"enabled": True, "permissions": {"reply": True}})
    assert store._read()["qq"]["permissions"]["reply"] is False


def test_permission_endpoint_cannot_reassert_enabled_even_for_a_previously_enabled_account(native_host):
    store = SocialAccounts()
    store.connect("qq")
    native_host[0].update(status="disconnected", connected=False, actualSelfId=None)
    before = store._path().read_bytes()
    with pytest.raises(SocialError):
        store.put("qq", {"enabled": True, "permissions": {"reply": False}})
    assert store._path().read_bytes() == before
