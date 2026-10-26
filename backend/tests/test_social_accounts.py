import io
import json
import zipfile

import pytest

from app.services.social import SocialAccounts, SocialError


def configured(store, provider="qq", **changes):
    values = {
        "enabled": True,
        "accountId": provider + "-main",
        "expectedSelfId": "10001" if provider == "qq" else "wxid_momo",
        "endpoint": "ws://127.0.0.1:3001" if provider == "qq" else "http://127.0.0.1:3002",
        "token": "private-bridge-token",
        "permissions": {"receive": True, "reply": True},
        **changes,
    }
    return store.put(provider, values)


def event(**changes):
    return {"source": "qq", "accountId": "qq-main", "selfId": "10001",
            "peerId": "20002", "senderId": "20002", "conversationKind": "private",
            "externalMessageId": "message-1", "text": "hello", **changes}


def test_optional_allowlist_is_strict_only_when_enabled():
    store = SocialAccounts()
    account = configured(store, allowlist=[{"peerId": "99999"}])
    admitted = store.authorize_event(event(policyRevision=account["policyRevision"]))
    assert admitted["audience"] != "owner"
    store.put("qq", {"allowlistEnabled": True})
    assert store.authorize_event(event()) is None
    store.put("qq", {"allowlist": []})
    assert store.authorize_event(event()) is None
    store.put("qq", {"allowlistEnabled": False})
    assert store.authorize_event(event()) is not None


def test_identity_permissions_revision_and_echo_are_rechecked():
    store = SocialAccounts()
    account = configured(store)
    rev = account["policyRevision"]
    assert store.authorize_send("qq-main", "20002", rev, audience=store.authorize_event(event())["audience"])["provider"] == "qq"
    assert store.authorize_event(event(selfId="wrong")) is None
    assert store.authorize_event(event(senderId="10001")) is None
    assert store.authorize_event(event(conversationKind="group")) is None
    store.put("qq", {"permissions": {"receive": True, "reply": False}})
    with pytest.raises(SocialError):
        store.authorize_send("qq-main", "20002", rev, audience=store.authorize_event(event())["audience"])
    with pytest.raises(SocialError):
        store.authorize_send("qq-main", "20002", rev + 1, audience=store.authorize_event(event())["audience"])


def test_tokens_are_write_only_and_outside_default_export():
    from app.services.archive import export_data
    store = SocialAccounts()
    account = configured(store)
    assert account["hasCredential"] is True
    assert "private-bridge-token" not in json.dumps(account)
    assert "private-bridge-token" not in json.dumps(store.list_accounts())
    assert store.host_configs()[0]["credential"]["token"] == "private-bridge-token"
    store.put("qq", {"permissions": {"receive": True, "reply": True}})
    assert store.host_configs()[0]["credential"]["token"] == "private-bridge-token"
    with zipfile.ZipFile(io.BytesIO(export_data())) as archive:
        assert all("private-bridge-token".encode() not in archive.read(name) for name in archive.namelist())


def test_owner_binding_requires_one_time_proof_from_exact_peer():
    store = SocialAccounts()
    configured(store)
    challenge = store.owner_challenge("qq", "20002")
    assert store.authorize_event(event(senderId="33333", peerId="33333", text=challenge["challenge"])) is not None
    assert store.get("qq")["ownerPeerId"] is None
    assert store.authorize_event(event(text=challenge["challenge"])) is None
    assert store.get("qq")["ownerPeerId"] == "20002"
    assert store.authorize_event(event(text="ordinary follow up"))["audience"] == "owner"
    configured(store, expectedSelfId="10003")
    assert store.get("qq")["ownerPeerId"] is None


def test_no_fake_permissions_or_unsafe_endpoint_credentials():
    store = SocialAccounts()
    with pytest.raises(SocialError):
        configured(store, endpoint="ws://secret:password@127.0.0.1:3001")
    with pytest.raises(SocialError):
        configured(store, permissions={"receive": True, "reply": True, "proactive": True})
    with pytest.raises(SocialError):
        configured(store, ownerPeerId="20002")


def test_disabled_or_quarantined_account_has_no_business_authority():
    store = SocialAccounts()
    configured(store)
    store.quarantine("qq")
    assert not store.host_configs()
    assert store.authorize_event(event()) is None
    assert store.get("qq")["status"] == "quarantined"
    with pytest.raises(SocialError):
        store.authorize_send("qq-main", "20002", store.get("qq")["policyRevision"], audience="owner")


def test_profile_isolation_keeps_social_accounts_separate(tmp_path, monkeypatch):
    from app.core import state
    store = SocialAccounts()
    configured(store)
    monkeypatch.setattr(state, "DATA_DIR", tmp_path / "another-profile")
    assert store.get("qq")["enabled"] is False
    assert store.get("qq")["hasCredential"] is False


def test_canonical_profile_alias_can_read_private_account_storage(tmp_path, monkeypatch):
    from app.core import state
    parent = tmp_path / "actual"
    parent.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(parent, target_is_directory=True)
    monkeypatch.setattr(state, "DATA_DIR", alias / "life")
    store = SocialAccounts()
    assert len(store.list_accounts()["accounts"]) == 2
    configured(store)
    monkeypatch.setattr(state, "DATA_DIR", parent / "life")
    assert store.get("qq")["enabled"] is True


def test_changed_account_does_not_inherit_previous_credential():
    store = SocialAccounts()
    configured(store)
    store.put("qq", {"accountId": "qq-another", "expectedSelfId": "30003"})
    assert store.get("qq")["hasCredential"] is False
    assert store.host_configs()[0]["credential"] == {}


def test_owner_relink_cannot_authorize_old_owners_inflight_private_reply():
    store = SocialAccounts()
    account = configured(store)
    proof = store.owner_challenge("qq", "20002")
    store.authorize_event(event(text=proof["challenge"]))
    original = store.authorize_event(event())
    assert original["audience"] == "owner"
    next_proof = store.owner_challenge("qq", "33333")
    store.authorize_event(event(peerId="33333", senderId="33333", text=next_proof["challenge"]))
    with pytest.raises(SocialError):
        store.authorize_send("qq-main", "20002", store.get("qq")["policyRevision"], audience=original["audience"])


def test_owner_relink_revokes_old_binding_before_new_proof(monkeypatch):
    store = SocialAccounts()
    configured(store)
    first = store.owner_challenge("qq", "20002")
    store.authorize_event(event(text=first["challenge"]))
    old = store.get("qq")
    refreshed = []
    monkeypatch.setattr(store, "_refresh", lambda: refreshed.append(store._account("qq")))
    next_proof = store.owner_challenge("qq", "33333")
    assert refreshed[-1]["ownerPeerId"] is None
    assert refreshed[-1]["policyRevision"] > old["policyRevision"]
    assert store.authorize_event(event(policyRevision=old["policyRevision"])) is None
    assert store.authorize_event(event(peerId="33333", senderId="33333", text=next_proof["challenge"], policyRevision=refreshed[-1]["policyRevision"])) is None
    assert store.get("qq")["ownerPeerId"] == "33333"
