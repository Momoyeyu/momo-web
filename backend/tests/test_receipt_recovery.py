import json
from pathlib import Path
import shutil
import pytest
from app.core import db
from app.core.plugin_host import HostError
from app.services.coordinator import Coordinator, CoordinationError


@pytest.mark.parametrize("status", ["completed", "delivered"])
def test_lost_response_cannot_downgrade_a_confirmed_receipt(status):
    core = Coordinator()
    core.schema()

    class Host:
        def permit(self, run_id):
            return {"commandId": "known", "activityEpoch": 0}

        def request(self, *args, **kwargs):
            core.record_receipt(
                {"commandId": "known", "runId": "run", "status": status}
            )
            raise HostError("response timed out after receipt")

    core.host = Host()
    with pytest.raises(HostError):
        core.command("plugins.callTool", {"name": "test"}, "run")
    row = db.query("SELECT status,receipt FROM outbox WHERE command_id='known'")[0]
    assert row["status"] == status
    assert json.loads(row["receipt"])["status"] == status


def test_late_receipt_missing_from_restored_snapshot_is_retained_without_replay():
    core = Coordinator()
    core.schema()
    core.mode = "paused"
    core.epoch = 9
    core.record_receipt(
        {
            "commandId": "after-backup",
            "runId": "original-run",
            "activityEpoch": 2,
            "status": "delivered",
            "stale": True,
        }
    )
    row = db.query("SELECT * FROM outbox WHERE command_id='after-backup'")[0]
    assert (
        row["status"] == "delivered"
        and row["run_id"] == "original-run"
        and row["epoch"] == 2
    )
    assert core.active is None and core.queue == [] and core.mode == "paused"
    assert db.query("SELECT COUNT(*) n FROM inbox")[0]["n"] == 0


def test_activity_start_ack_does_not_replace_the_full_started_receipt():
    core = Coordinator()
    core.start()
    try:
        core.host.request(
            "plugins.configure", {"plugins": [{"id": "virtual", "type": "virtual"}]}
        )
        core.enter("client-one")
        with core.run("activity-run", source="virtual"):
            ack = core.command("virtual.activityStart", {"tickMs": 100}, "activity-run")
        row = db.query(
            "SELECT status,receipt FROM outbox WHERE command_id=?", (ack["commandId"],)
        )[0]
        receipt = json.loads(row["receipt"])
        assert row["status"] == "started"
        assert receipt["runId"] == "activity-run"
        assert receipt["coreInstance"] == core.core_id
        assert receipt["hostInstance"] == core.host.host_instance
    finally:
        core.close()


def test_unknown_mcp_outcome_survives_restart_until_explicit_reconciliation():
    core = Coordinator()
    core.schema()
    with db.tx() as c:
        c.execute(
            "INSERT INTO outbox VALUES('uncertain','old-run',0,'pending',?,NULL,?)",
            (json.dumps({"method": "plugins.callTool"}), db.now_iso()),
        )
    core.start()
    try:
        assert core.mode == "paused"
        with pytest.raises(CoordinationError, match="[Rr]econcil"):
            core.enter("client-one")
        with pytest.raises(CoordinationError, match="outcome"):
            core.reconcile_command("uncertain", "unknown")
        core.reconcile_command("uncertain", "completed")
        assert core.mode == "paused"
        row = db.query("SELECT status,receipt FROM outbox WHERE command_id='uncertain'")[0]
        assert row["status"] == "completed"
        assert json.loads(row["receipt"])["runId"] == "old-run"
        assert core.enter("client-one")["mode"] == "meeting"
    finally:
        core.close()


def test_rejected_mcp_dispatch_does_not_create_an_unknown_effect_barrier():
    core = Coordinator()
    core.start()
    try:
        lease = core.enter("client-one")
        with core.run("rejected-run", source="virtual"):
            with pytest.raises(HostError, match="TOOL_UNAVAILABLE"):
                core.command("plugins.callTool", {"name": "missing"}, "rejected-run")
        row = db.query("SELECT status FROM outbox WHERE run_id='rejected-run'")[0]
        assert row["status"] == "failed"
        assert core.mode == "meeting"
        assert core.heartbeat("client-one", lease["leaseId"])["mode"] == "meeting"
    finally:
        core.close()


@pytest.mark.parametrize("code", ["PLUGIN_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "FORBIDDEN", "INPUT"])
def test_rejected_channel_gate_is_known_unsent_not_an_unknown_outcome(monkeypatch, code):
    from app.services.social import social
    core = Coordinator()
    core.schema()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": float("inf")}
    core.active = "run"
    monkeypatch.setattr(social, "authorize_send", lambda *a, **k: None)

    class Host:
        def permit(self, run_id):
            return {"commandId": "rejected", "activityEpoch": 0}

        def request(self, method, params, **kwargs):
            raise HostError(code)

    core.host = Host()
    with pytest.raises(HostError, match=code):
        core.command("channels.send", {
            "pluginId": "momo-qq", "accountId": "account", "peerId": "peer",
            "policyRevision": 1, "audience": "owner", "text": "hello",
        }, "run")
    assert db.query("SELECT status FROM outbox WHERE command_id='rejected'")[0]["status"] == "failed"
    assert core._unresolved_commands() == []
    assert core.mode == "meeting"


def test_late_unsent_error_code_cannot_downgrade_an_unknown_channel_receipt(monkeypatch):
    from app.services.social import social
    core = Coordinator()
    core.schema()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": float("inf")}
    core.active = "run"
    monkeypatch.setattr(social, "authorize_send", lambda *a, **k: None)

    class Host:
        def permit(self, run_id):
            return {"commandId": "uncertain", "activityEpoch": 0}

        def request(self, method, params, **kwargs):
            core.record_receipt({"commandId": "uncertain", "runId": "run", "status": "unknown", "requiresReconciliation": True})
            raise HostError("PLUGIN_UNAVAILABLE")

    core.host = Host()
    with pytest.raises(HostError, match="PLUGIN_UNAVAILABLE"):
        core.command("channels.send", {
            "pluginId": "momo-qq", "accountId": "account", "peerId": "peer",
            "policyRevision": 1, "audience": "owner", "text": "hello",
        }, "run")
    assert db.query("SELECT status FROM outbox WHERE command_id='uncertain'")[0]["status"] == "unknown"
    assert len(core._unresolved_commands()) == 1
    assert core.mode == "paused"


def test_real_mcp_timeout_requires_observed_outcome_before_a_new_meeting():
    core = Coordinator()
    core.start()
    try:
        core.host.request("plugins.configure", {"plugins": [{
            "id": "echo", "type": "mcp", "transport": "stdio",
            "command": shutil.which("node"),
            "args": [str(Path(__file__).resolve().parents[2] / "plugin-host/test/fixtures/mcp-server.mjs")],
            "timeoutMs": 30, "connectTimeoutMs": 1000,
        }]})
        core.enter("client-one")
        with core.run("unknown-run", source="virtual"):
            with pytest.raises(HostError, match="MCP_CALL"):
                core.command("plugins.callTool", {"name": "echo__slow"}, "unknown-run")
        row = db.query("SELECT * FROM outbox WHERE run_id='unknown-run'")[0]
        assert row["status"] == "unknown"
        assert json.loads(row["receipt"])["requiresReconciliation"] is True
        assert core.mode == "paused"
        with pytest.raises(CoordinationError, match="[Rr]econcil"):
            core.enter("client-one")
        core.reconcile_command(row["command_id"], "completed")
        assert core.mode == "paused"
        assert core.host.request("status")["unresolvedCommands"] == []
        assert core.enter("client-one")["mode"] == "meeting"
    finally:
        core.close()
