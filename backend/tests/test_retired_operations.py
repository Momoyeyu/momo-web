"""Archived sends can stop blocking Boot without resurrecting their channel."""
import json

import pytest
from fastapi.testclient import TestClient

from app.core import db
from app.main import app
from app.services.coordinator import Coordinator, CoordinationError


def seed(core, command_id="old-command", *, plugin="momo-wechat", method="channels.send", status="unknown"):
    core.schema()
    payload = {"method": method, "pluginId": plugin, "accountId": "old-account", "peerId": "old-peer"}
    receipt = {"commandId": command_id, "runId": "old-run", "status": "unknown", "deliveryStatus": "unknown"}
    with db.tx() as c:
        c.execute("INSERT INTO outbox VALUES(?,'old-run',0,?,?,?,?)", (command_id, status, json.dumps(payload), json.dumps(receipt), db.now_iso()))
        c.execute("INSERT INTO command_receipts(command_id,receipt,at) VALUES(?,?,?)", (command_id, json.dumps(receipt), db.now_iso()))


def test_retired_recovery_is_authenticated_and_requires_strict_explicit_confirmation(monkeypatch):
    core = Coordinator()
    seed(core)
    from app.api import social
    monkeypatch.setattr(social, "runtime", core)
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "isolated-local-capability")
    client = TestClient(app)
    assert client.get("/api/social/accounts/retired/records").status_code == 403
    assert client.post("/api/social/accounts/retired/end-wait", json={"commandId": "old-command", "executorStopped": True}).status_code == 403
    headers = {"x-momo-token": "isolated-local-capability"}
    for body in [{"commandId": "old-command"}, {"commandId": "old-command", "executorStopped": False}, {"commandId": "old-command", "executorStopped": "true"}, {"commandId": "old-command", "executorStopped": True, "outcome": "completed"}]:
        assert client.post("/api/social/accounts/retired/end-wait", headers=headers, json=body).status_code == 422
    assert db.query("SELECT status FROM outbox")[0]["status"] == "unknown"


@pytest.mark.parametrize("plugin,method,status", [("momo-qq", "channels.send", "unknown"), ("momo-other", "channels.send", "unknown"), ("momo-wechat", "plugins.callTool", "unknown"), ("momo-wechat", "channels.send", "completed")])
def test_retired_recovery_cannot_close_other_providers_methods_or_known_outcomes(monkeypatch, plugin, method, status):
    from app.api import social
    core = Coordinator()
    seed(core, plugin=plugin, method=method, status=status)
    monkeypatch.setattr(social, "runtime", core)
    client = TestClient(app)
    assert client.get("/api/social/accounts/retired/records").json() == {"records": []}
    response = client.post("/api/social/accounts/retired/end-wait", json={"commandId": "old-command", "executorStopped": True})
    assert response.status_code == 400
    assert db.query("SELECT status FROM outbox")[0]["status"] == status


def test_startup_retired_unknown_can_end_wait_idempotently_then_boot_without_replay(monkeypatch):
    from app.api import social
    from app.services import turn
    core = Coordinator()
    seed(core, status="pending")
    with db.tx() as c:
        c.execute("INSERT INTO inbox(id,source,account_id,external_id,text,status,run_id,at) VALUES('old-input','wechat','old-account','event','retained input','queued','old-run',?)", (db.now_iso(),))
    monkeypatch.setattr(social, "runtime", core)
    monkeypatch.setattr(social.social, "_read", lambda: pytest.fail("recovery must not inspect private account configuration"))
    called = []
    monkeypatch.setattr(turn, "run_turn", lambda *a, **k: called.append("inference") or iter([]))
    client = TestClient(app)
    core.start()
    try:
        with pytest.raises(CoordinationError, match="[Rr]econcil"):
            core.enter("client-one")
        records = client.get("/api/social/accounts/retired/records").json()["records"]
        assert len(records) == 1 and records[0]["source"] == "wechat" and records[0]["status"] == "unknown"
        assert set(records[0]) == {"commandId", "source", "accountId", "peerId", "status", "createdAt", "deliveryStatus"}
        first = client.post("/api/social/accounts/retired/end-wait", json={"commandId": "old-command", "executorStopped": True})
        assert first.status_code == 200 and first.json()["attention"]["activation"] == "dormant"
        assert first.json()["records"] == []
        row = db.query("SELECT * FROM outbox")[0]
        receipt = json.loads(row["receipt"])
        assert row["status"] == "closed_unknown" and receipt["deliveryStatus"] == "unknown"
        assert receipt["executorStoppedByUser"] is True
        assert receipt.get("executorQuiescent") is None, "human stop confirmation is not machine evidence"
        assert len(db.query("SELECT * FROM command_receipts")) == 2
        assert client.post("/api/social/accounts/retired/end-wait", json={"commandId": "old-command", "executorStopped": True}).status_code == 200
        assert len(db.query("SELECT * FROM command_receipts")) == 2
        assert core.enter("client-one")["activation"] == "active"
        # A duplicated old recovery request cannot revoke the new Boot lease.
        duplicate = client.post("/api/social/accounts/retired/end-wait", json={"commandId": "old-command", "executorStopped": True})
        assert duplicate.status_code == 200 and duplicate.json()["attention"]["activation"] == "active"
        assert db.query("SELECT text FROM inbox")[0]["text"] == "retained input"
        assert called == []
        host = core.host.request("status")
        assert host["plugins"] == [] and host["inflight"] == 0
        assert len(db.query("SELECT * FROM outbox")) == 1
        core.record_receipt({"commandId": "old-command", "runId": "old-run", "pluginId": "momo-wechat", "accountId": "old-account", "peerId": "old-peer", "status": "completed", "deliveryStatus": "provider_accepted", "late": True})
        assert db.query("SELECT status FROM outbox")[0]["status"] == "completed"
        assert len(db.query("SELECT * FROM command_receipts")) == 3
        assert called == [] and core.host.request("status")["plugins"] == []
    finally:
        core.close()


def test_closing_retired_wait_does_not_clear_other_unknown_effects(monkeypatch):
    from app.api import social
    core = Coordinator()
    seed(core)
    seed(core, "mcp-command", plugin="other-plugin", method="plugins.callTool")
    core.started, core.mode = True, "paused"
    monkeypatch.setattr(social, "runtime", core)
    response = TestClient(app).post("/api/social/accounts/retired/end-wait", json={"commandId": "old-command", "executorStopped": True})
    assert response.status_code == 200 and response.json()["attention"]["activation"] == "fault"
    assert [row["command_id"] for row in core._unresolved_commands()] == ["mcp-command"]
