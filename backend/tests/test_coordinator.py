import threading
import time
from pathlib import Path
import pytest
from app.core import db, state
from app.core.instance_lock import InstanceLock
from app.services.coordinator import Coordinator, CoordinationError


@pytest.fixture
def core(monkeypatch):
    monkeypatch.setenv("MOMO_TEST_VIRTUAL", "1")
    instance = Coordinator()
    instance.start()
    instance.host.request(
        "plugins.configure",
        {"plugins": [{"id": "virtual", "type": "virtual", "enabled": True}]},
    )
    try:
        yield instance
    finally:
        instance.close()


def test_profile_lock_survives_profile_rename(tmp_path):
    data = tmp_path / "profile"
    data.mkdir()
    first = InstanceLock(data).acquire()
    try:
        data.rename(tmp_path / "backup")
        data.mkdir()
        with pytest.raises(RuntimeError, match="Another momo"):
            InstanceLock(data).acquire()
    finally:
        first.close()
    second = InstanceLock(data).acquire()
    second.close()


def test_whole_turn_queue_is_serial_and_fifo():
    instance = Coordinator()
    order = []
    first = threading.Event()
    release = threading.Event()

    def a():
        with instance.run("a"):
            order.append("a:start")
            first.set()
            release.wait(2)
            order.append("a:end")

    def b():
        with instance.run("b"):
            order.append("b")

    one = threading.Thread(target=a)
    two = threading.Thread(target=b)
    one.start()
    assert first.wait(1)
    two.start()
    time.sleep(0.03)
    assert order == ["a:start"]
    release.set()
    one.join(2)
    two.join(2)
    assert order == ["a:start", "a:end", "b"]


def test_real_host_meeting_preempts_activity_and_holds_inbox(core):
    with core.run("playing", source="virtual"):
        started = core.command("virtual.activityStart", {"tickMs": 20}, "playing")
    assert started["started"]
    lease = core.enter("client-one")
    assert core.host.request("status")["activity"] is None
    assert core.mode == "meeting"
    with pytest.raises(CoordinationError, match="Another window"):
        core.enter("client-two")
    first = core.enqueue("virtual", "account", "same-message", "hello")
    again = core.enqueue("virtual", "account", "same-message", "hello")
    assert first["id"] == again["id"]
    time.sleep(0.25)
    assert (
        db.query("SELECT status FROM inbox WHERE id=?", (first["id"],))[0]["status"]
        == "queued"
    )
    with core.run("meeting-run", client="client-one", lease=lease["leaseId"]):
        with pytest.raises(CoordinationError, match="unavailable during"):
            core.command("virtual.deliver", {"text": "bad"}, "meeting-run")


def test_refresh_rotates_lease_and_expiry_pauses(core):
    old = core.enter("client-one")
    fresh = core.enter("client-one", old["leaseId"])
    assert old["leaseId"] != fresh["leaseId"]
    with pytest.raises(CoordinationError):
        core.heartbeat("client-one", old["leaseId"])
    core.owner["expiresAt"] = time.monotonic() - 1
    with pytest.raises(CoordinationError):
        core.heartbeat("client-one", fresh["leaseId"])
    assert core.mode == "paused" and core.owner is None


def test_restore_barrier_revokes_and_never_replays_pending(core):
    lease = core.enter("client-one")
    pending = core.enqueue("virtual", "account", "later", "hi")
    with core.maintenance():
        with pytest.raises(CoordinationError):
            core.enter("client-two")
    assert core.mode == "paused" and core.owner is None
    assert (
        db.query("SELECT status FROM inbox WHERE id=?", (pending["id"],))[0]["status"]
        == "interrupted"
    )
    with pytest.raises(CoordinationError):
        core.require_meeting("client-one", lease["leaseId"])


def test_late_external_receipt_is_fact_but_never_new_permission(core):
    with db.tx() as c:
        c.execute(
            "INSERT INTO outbox VALUES('old','old-run',0,'unknown','{}',NULL,?)",
            (db.now_iso(),),
        )
    core.enter("client-one")
    core.event(
        "receipt",
        {
            "commandId": "old",
            "runId": "old-run",
            "activityEpoch": 0,
            "status": "delivered",
            "stale": True,
        },
    )
    assert (
        db.query("SELECT status FROM outbox WHERE command_id='old'")[0]["status"]
        == "delivered"
    )
    assert core.active is None and core.mode == "meeting"


def test_second_core_is_refused(core):
    other = Coordinator()
    with pytest.raises(RuntimeError, match="Another momo"):
        other.start()
