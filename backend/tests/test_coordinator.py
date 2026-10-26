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


def test_real_host_boot_allows_phone_and_focus_holds_inbox(core):
    with pytest.raises(CoordinationError, match="not activated"):
        with core.run("dormant", source="virtual"):
            pass
    lease = core.enter("client-one")
    with core.run("playing", source="virtual"):
        started = core.command("virtual.activityStart", {"tickMs": 20}, "playing")
    assert started["started"]
    with pytest.raises(CoordinationError, match="Another window"):
        core.enter("client-two")
    core.control("client-one", lease["leaseId"], "focus", "focus_on")
    assert core.host.request("status")["activity"] is None
    first = core.enqueue("virtual", "account", "same-message", "hello")
    again = core.enqueue("virtual", "account", "same-message", "hello")
    assert first["id"] == again["id"]
    time.sleep(.1)
    assert db.query("SELECT status FROM inbox WHERE id=?", (first["id"],))[0]["status"] == "held_focus"
    with core.run("local-run", client="client-one", lease=lease["leaseId"]):
        with pytest.raises(CoordinationError, match="focusing"):
            core.command("virtual.deliver", {"text": "blocked"}, "local-run")


def test_refresh_rotates_lease_and_expiry_pauses(core):
    old = core.enter("client-one")
    fresh = core.enter("client-one", old["leaseId"])
    assert old["leaseId"] != fresh["leaseId"]
    with pytest.raises(CoordinationError):
        core.heartbeat("client-one", old["leaseId"])
    core.control("client-one", fresh["leaseId"], "pause-before-expiry", "stop")
    core.control("client-one", fresh["leaseId"], "focus-before-expiry", "focus_on")
    core.owner["expiresAt"] = time.monotonic() - 1
    with pytest.raises(CoordinationError):
        core.heartbeat("client-one", fresh["leaseId"])
    assert core.mode == "paused" and core.owner is None
    assert core.focus is False and core.phone_paused is True


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


def test_delayed_mcp_configuration_cannot_replace_newer_combined_state(monkeypatch):
    from app.services.social import social

    instance = Coordinator()
    entered = threading.Event()
    release = threading.Event()
    applied = []
    social_configs = []

    class Host:
        def request(self, method, params, **kwargs):
            assert method == "plugins.configure"
            if params["configurationRevision"] == 1:
                entered.set()
                assert release.wait(3)
            if not applied or params["configurationRevision"] > applied[-1]["configurationRevision"]:
                applied.append(params)
                return {"ok": True}
            return {"stale": True}

    instance.host = Host()
    monkeypatch.setattr(social, "host_configs", lambda: list(social_configs))
    old = [{"id": "old-mcp", "type": "mcp"}]
    current = [{"id": "current-mcp", "type": "mcp"}]
    worker = threading.Thread(target=lambda: instance.configure_host_plugins(old, revision=1))
    worker.start()
    assert entered.wait(1)
    try:
        instance.configure_host_plugins(current, revision=2)
        social_configs.append({"id": "social", "type": "social"})
        instance.refresh_social_plugins()
        # The older MCP revision is rejected before it can overwrite the cache,
        # even though the first host request is still in flight.
        assert instance.configure_host_plugins(old, revision=1) == {"stale": True}
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive()
    assert instance.mcp_configs == current
    assert instance.mcp_revision == 2
    assert [item["configurationRevision"] for item in applied] == [2, 3]
    assert applied[-1]["plugins"] == current + social_configs
