"""QQ can release an uncertain wait only after its owned executor is stopped."""
import json
import threading
import time
from contextlib import nullcontext

import pytest

from app.core import db
from app.services import coordinator
from app.services.coordinator import Coordinator, CoordinationError
from app.services.social import social


def seed(core, command="qq-unknown", *, plugin="momo-qq", method="channels.send"):
    core.schema()
    payload = {"method": method, "pluginId": plugin, "accountId": "qq-main", "peerId": "20002"}
    with db.tx() as c:
        c.execute("INSERT INTO outbox VALUES(?,'original-run',1,'unknown',?,NULL,?)", (command, json.dumps(payload), db.now_iso()))
    return {"commandId": command, "runId": "original-run", "activityEpoch": 1,
            "pluginId": plugin, "accountId": "qq-main", "peerId": "20002",
            "status": "unknown", "deliveryStatus": "unknown"}


class OwnedHost:
    host_instance = "owned-host"
    control = nullcontext()

    def __init__(self, *, stopped=True, known=True):
        self.stopped, self.known = stopped, known
        self.closed = threading.Event()
        self.calls = []

    def request(self, method, params=None, timeout=None):
        self.calls.append((method, params))
        if method == "qq.settleUnknown":
            if not self.stopped or not self.known:
                return {"settled": False, "executorQuiescent": False}
            return {"settled": True, "executorQuiescent": True, "receipt": {
                "commandId": params["commandId"], "runId": "original-run", "activityEpoch": 1,
                "pluginId": "momo-qq", "accountId": "qq-main", "peerId": "20002",
                "status": "closed_unknown", "deliveryStatus": "unknown",
                "executorQuiescent": True, "automatic": True,
            }}
        if method == "revoke":
            return {"stopped": True, "unknownExternal": False}
        return {}


def running_core(monkeypatch, **host_options):
    core = Coordinator()
    core.schema()
    core.started, core.mode = True, "paused"
    core.host = OwnedHost(**host_options)
    monkeypatch.setattr(coordinator, "runtime", core)
    account = social._default("qq")
    account.update(enabled=True, expectedSelfId="10001", ownerPeerId="20002")
    social._write({"qq": account})
    return core


def finished(core):
    worker = getattr(core, "qq_recovery_thread", None)
    assert worker is not None, "unknown QQ send must schedule automatic recovery"
    worker.join(2)
    assert not worker.is_alive()


def test_unknown_qq_delivery_is_automatically_closed_without_a_delivery_claim_or_boot(monkeypatch):
    core = running_core(monkeypatch)
    receipt = seed(core)
    core.record_receipt(receipt)
    finished(core)
    row = db.query("SELECT * FROM outbox")[0]
    closed = json.loads(row["receipt"])
    assert row["status"] == "closed_unknown"
    assert closed["deliveryStatus"] == "unknown" and closed["executorQuiescent"] is True
    assert closed["automatic"] is True
    account = social._read()["qq"]
    assert account["enabled"] is False and account["quarantined"] is True
    assert account["ownerPeerId"] == "20002"
    assert core.mode == "dormant" and core.owner is None
    assert core.enter("local-player")["activation"] == "active"
    assert not any(method in {"channels.send", "qq.runtime.begin", "qq.runtime.restore"} for method, _ in core.host.calls)


@pytest.mark.parametrize("options", [{"stopped": False}, {"known": False}])
def test_unproven_or_still_running_qq_executor_cannot_be_automatically_reconciled(monkeypatch, options):
    core = running_core(monkeypatch, **options)
    core.record_receipt(seed(core))
    finished(core)
    assert db.query("SELECT status FROM outbox")[0]["status"] == "unknown"
    assert core.mode == "paused"
    with pytest.raises(CoordinationError):
        core.enter("local-player")


def test_qq_recovery_never_settles_an_unknown_mcp_effect(monkeypatch):
    core = running_core(monkeypatch)
    seed(core, "other-unknown", plugin="other", method="plugins.callTool")
    core.record_receipt(seed(core))
    finished(core)
    assert [r["command_id"] for r in core._unresolved_commands()] == ["other-unknown"]
    assert core.mode == "paused"
    assert not any(params and params.get("commandId") == "other-unknown" for _, params in core.host.calls)


def test_original_late_provider_fact_supersedes_closed_unknown_without_replay_or_activation(monkeypatch):
    core = running_core(monkeypatch)
    receipt = seed(core)
    core.record_receipt(receipt)
    finished(core)
    core.record_receipt({**receipt, "status": "completed", "deliveryStatus": "provider_accepted", "externalMessageId": "provider-original", "late": True})
    assert db.query("SELECT status FROM outbox")[0]["status"] == "completed"
    assert core.mode == "dormant" and core.owner is None
    assert len(db.query("SELECT * FROM outbox")) == 1
    assert not any(method == "channels.send" for method, _ in core.host.calls)


def test_host_reader_does_not_wait_for_the_automatic_recovery_rpc(monkeypatch):
    core = running_core(monkeypatch)
    original = core.host.request
    entered, release = threading.Event(), threading.Event()

    def held(method, params=None, timeout=None):
        if method == "qq.settleUnknown":
            entered.set()
            assert release.wait(2)
        return original(method, params, timeout)

    monkeypatch.setattr(core.host, "request", held)
    start = time.monotonic()
    core.record_receipt(seed(core))
    assert time.monotonic() - start < .2
    assert entered.wait(1)
    release.set()
    finished(core)


def test_recovery_reply_from_replaced_host_cannot_mutate_the_new_lifetime(monkeypatch):
    core = running_core(monkeypatch)
    original = core.host

    def replaced(method, params=None, timeout=None):
        if method == "qq.settleUnknown":
            core.host = OwnedHost()
            core.core_id = "replacement-core"
            return OwnedHost.request(original, method, params, timeout)
        return OwnedHost.request(original, method, params, timeout)

    monkeypatch.setattr(original, "request", replaced)
    core.record_receipt(seed(core))
    finished(core)
    assert db.query("SELECT status FROM outbox")[0]["status"] == "unknown"
    assert core.mode == "paused"


def test_recovery_waits_for_original_turn_to_unwind_and_never_overlaps_its_execution(monkeypatch):
    core = running_core(monkeypatch)
    core.active = "original-run"
    core.record_receipt(seed(core))
    time.sleep(.02)
    assert core.host.calls == []
    assert db.query("SELECT status FROM outbox")[0]["status"] == "unknown"
    with core.condition:
        core.active = None
        core.condition.notify_all()
    finished(core)
    assert core.mode == "dormant"


def test_shutdown_invalidates_a_blocked_recovery_before_it_can_change_a_later_lifetime(monkeypatch):
    core = running_core(monkeypatch)
    core.active = "original-run"
    core.record_receipt(seed(core))
    with core.condition:
        core.closed.set()
        core.qq_recovery_owner = None
        core.condition.notify_all()
    finished(core)
    assert core.host.calls == []
    assert db.query("SELECT status FROM outbox")[0]["status"] == "unknown"


def test_shutdown_owned_stop_receipt_persists_policy_withdrawal_without_starting_another_worker(monkeypatch):
    core = running_core(monkeypatch)
    receipt = seed(core)
    core.closed.set()
    core.record_receipt({**receipt, "status": "closed_unknown", "executorQuiescent": True, "automatic": True})
    account = social._read()["qq"]
    assert account["enabled"] is False and account["quarantined"] is True
    assert account["ownerPeerId"] == "20002"
    assert core.qq_recovery_thread is None and core.mode == "paused"
    assert db.query("SELECT status FROM outbox")[0]["status"] == "closed_unknown"


def test_duplicate_old_shutdown_receipt_cannot_disable_a_later_explicit_connection(monkeypatch):
    core = running_core(monkeypatch)
    receipt = {**seed(core), "status": "closed_unknown", "executorQuiescent": True, "automatic": True}
    core.closed.set()
    core.record_receipt(receipt)
    data = social._read()
    data["qq"].update(enabled=True, quarantined=False, policyRevision=100)
    social._write(data)
    core.record_receipt(receipt)
    assert social._read()["qq"]["enabled"] is True
    assert social._read()["qq"]["policyRevision"] == 100


@pytest.mark.parametrize('action',['private.send','group.send','media.send','friends.respond','groups.manage'])
def test_reviewed_mutation_actions_use_the_same_automatic_unknown_recovery(monkeypatch,action):
    core=running_core(monkeypatch)
    receipt=seed(core,method='channels.action')
    row=db.query('SELECT * FROM outbox')[0]
    payload=json.loads(row['payload']);payload['action']=action
    with db.tx() as c:c.execute('UPDATE outbox SET payload=?',(json.dumps(payload),))
    core.record_receipt(receipt);finished(core)
    assert db.query('SELECT status FROM outbox')[0]['status']=='closed_unknown'
    assert social._account('qq')['enabled'] is False
    assert core.mode=='dormant'
    core.record_receipt({**receipt,'status':'completed','deliveryStatus':'provider_accepted'})
    assert db.query('SELECT status FROM outbox')[0]['status']=='completed'
