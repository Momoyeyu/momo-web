"""Adversarial checks at attention transitions and the actual ASGI/Node boundary."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.core import db, llm, state
from app.services import checkpoint
from app.services.coordinator import Coordinator, CoordinationError


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def live_core(monkeypatch):
    monkeypatch.setenv("MOMO_TEST_VIRTUAL", "1")
    core = Coordinator()
    core.start()
    core.host.request(
        "plugins.configure",
        {"plugins": [{"id": "virtual", "type": "virtual", "enabled": True}]},
    )
    try:
        yield core
    finally:
        core.close()


def test_maintenance_waits_for_an_inflight_attention_transition(live_core, monkeypatch):
    """Restore must not yield while an earlier enter can still grant execution."""
    core = live_core
    entered_revoke = threading.Event()
    release_enter = threading.Event()
    maintenance_entered = threading.Event()
    release_maintenance = threading.Event()
    real_revoke = core._revoke

    def gated_revoke(reason):
        if reason == "meeting":
            entered_revoke.set()
            assert release_enter.wait(3)
        return real_revoke(reason)

    monkeypatch.setattr(core, "_revoke", gated_revoke)

    def restore():
        with core.maintenance():
            maintenance_entered.set()
            assert release_maintenance.wait(3)

    with ThreadPoolExecutor(2) as pool:
        entering = pool.submit(core.enter, "client-one")
        assert entered_revoke.wait(1)
        restoring = pool.submit(restore)
        try:
            # No attention transition may cross the restore barrier.
            assert not maintenance_entered.wait(0.15)
        finally:
            release_enter.set()
            release_maintenance.set()
            entering.result(timeout=3)
            restoring.result(timeout=3)
    assert core.mode == "paused" and core.owner is None


def test_expired_lease_cleanup_does_not_revoke_a_new_meeting(live_core):
    core = live_core
    core.enter("client-one")
    core.owner["expiresAt"] = time.monotonic() - 1
    # _enter observes expiry while holding transition. Its scheduled expiry task
    # must not revoke the fresh grant created later in the same transition.
    fresh = core.enter("client-two")
    time.sleep(0.1)
    assert core.epoch == fresh["epoch"]
    assert not core.host.request("status")["paused"]
    assert core.heartbeat("client-two", fresh["leaseId"])["mode"] == "meeting"


def test_maintenance_exception_stays_paused_and_retires_pending(live_core):
    core = live_core
    core.enter("client-one")
    pending = core.enqueue("virtual", "account", "pending", "hello")
    with pytest.raises(ValueError, match="restore failed"):
        with core.maintenance():
            raise ValueError("restore failed")
    assert core.mode == "paused" and core.owner is None
    assert (
        db.query("SELECT status FROM inbox WHERE id=?", (pending["id"],))[0]["status"]
        == "interrupted"
    )
    assert core.host.request("status")["paused"]


def test_two_accounts_with_same_platform_message_id_remain_distinct(
    live_core, monkeypatch
):
    from app.services import turn

    core = live_core
    core.enter("client-one")
    monkeypatch.setattr(
        llm,
        "chat_stream",
        lambda *a, **k: iter([{"type": "text", "delta": "Received."}]),
    )
    first = core.enqueue("virtual", "account-one", "same-id", "first account")
    second = core.enqueue("virtual", "account-two", "same-id", "second account")

    def complete():
        rows = db.query(
            "SELECT status FROM inbox WHERE id IN (?,?)", (first["id"], second["id"])
        )
        return len(rows) == 2 and all(r["status"] == "completed" for r in rows)

    assert wait_for(complete)
    assert [m["text"] for m in checkpoint.live_messages() if m["role"] == "user"] == [
        "first account",
        "second account",
    ]


def test_actual_asgi_lifespan_lease_ack_replay_and_failure_release(monkeypatch):
    from app import main
    from app.api import chat, meeting, onboarding
    from app.services import coordinator

    core = Coordinator()
    for module in (main, chat, meeting, onboarding, coordinator):
        monkeypatch.setattr(module, "runtime", core)
    cfg = state.load()
    cfg["settings"]["llm"] = {"url": "https://example.test", "model": "test", "key": ""}
    state.write_state(cfg)
    with db.tx() as c:
        c.execute(
            "INSERT INTO meta(key,value) VALUES('first_meeting','{\"stage\":\"legacy\"}')"
        )
    attempts = []

    def reply(*a, **k):
        attempts.append(1)
        if len(attempts) == 1:
            raise llm.LlmError("synthetic provider failure")
        yield {"type": "text", "delta": "Hello."}

    monkeypatch.setattr(llm, "chat_stream", reply)
    with TestClient(main.app) as client:
        lease = client.post(
            "/api/meeting/enter", json={"clientId": "client-one"}
        ).json()
        owner = {"clientId": "client-one", "leaseId": lease["leaseId"]}
        assert (
            client.post(
                "/api/chat", json={**owner, "text": "first", "messageId": "first"}
            ).status_code
            == 200
        )
        assert core.active is None and not core.queue
        response = client.post(
            "/api/chat", json={**owner, "text": "second", "messageId": "second"}
        )
        events = [
            json.loads(line[6:])
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]
        sentence = next(e for e in events if e["t"] == "sentence")
        ack = {
            "runId": sentence["runId"],
            "generation": sentence["generation"],
            "text": "Hello.",
        }
        assert (
            client.post(
                "/api/life/ack",
                json={**ack, "clientId": "other-client", "leaseId": lease["leaseId"]},
            ).status_code
            == 409
        )
        assert checkpoint.live_messages() == []
        assert client.post("/api/life/ack", json={**ack, **owner}).status_code == 200
        assert (
            client.post(
                "/api/chat", json={**owner, "text": "second", "messageId": "second"}
            ).status_code
            == 409
        )
        fresh = client.post("/api/meeting/enter", json=owner).json()
        assert fresh["leaseId"] != lease["leaseId"]
        assert (
            client.post(
                "/api/life/ack",
                json={**ack, "clientId": "client-one", "leaseId": fresh["leaseId"]},
            ).status_code
            == 409
        )
    assert core.host.process.poll() is not None


def test_unobserved_first_meeting_opening_can_resume_after_refresh(monkeypatch):
    from app import main
    from app.api import chat, meeting, onboarding
    from app.services import coordinator

    core = Coordinator()
    for module in (main, chat, meeting, onboarding, coordinator):
        monkeypatch.setattr(module, "runtime", core)
    cfg = state.load()
    cfg["settings"]["llm"] = {"url": "https://example.test", "model": "test", "key": ""}
    state.write_state(cfg)
    with TestClient(main.app) as client:
        old = client.post("/api/meeting/enter", json={"clientId": "client-one"}).json()
        first = client.post(
            "/api/onboarding/opening",
            json={"clientId": "client-one", "leaseId": old["leaseId"]},
        )
        assert '"t": "sentence"' in first.text
        assert (
            checkpoint.live_messages() == []
        )  # simulated browser closed before displaying
        fresh = client.post(
            "/api/meeting/enter",
            json={"clientId": "client-one", "leaseId": old["leaseId"]},
        ).json()
        resumed = client.post(
            "/api/onboarding/opening",
            json={"clientId": "client-one", "leaseId": fresh["leaseId"]},
        )
        assert '"t": "sentence"' in resumed.text


def test_python_death_closes_its_real_node_child(tmp_path):
    """EOF on the private pipe must dispose the owned host after an abrupt parent death."""
    import sys

    child_code = """import json,sys
from app.services.coordinator import Coordinator
core=Coordinator()
core.start()
print(json.dumps({'pid':core.host.process.pid}),flush=True)
sys.stdin.read()
core.close()
"""
    env = {k: v for k, v in os.environ.items() if not k.startswith("MOMO_")}
    env["MOMO_DATA_DIR"] = str(tmp_path / "child-profile")
    process = subprocess.Popen(
        [sys.executable, "-c", child_code],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    node_pid = None
    try:
        packet = json.loads(process.stdout.readline())
        node_pid = packet["pid"]
        process.terminate()
        process.wait(timeout=3)

        def dead():
            try:
                os.kill(node_pid, 0)
            except ProcessLookupError:
                return True
            return False

        assert wait_for(dead, timeout=4)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        if node_pid:
            try:
                os.kill(node_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass


def test_partial_opening_recovery_keeps_seen_prefix_and_emits_only_remainder(
    monkeypatch,
):
    from app import main
    from app.api import chat, meeting, onboarding
    from app.services import coordinator

    core = Coordinator()
    for module in (main, chat, meeting, onboarding, coordinator):
        monkeypatch.setattr(module, "runtime", core)
    cfg = state.load()
    cfg["settings"]["llm"] = {"url": "https://example.test", "model": "test", "key": ""}
    state.write_state(cfg)
    with TestClient(main.app) as client:
        old = client.post("/api/meeting/enter", json={"clientId": "client-one"}).json()
        owner = {"clientId": "client-one", "leaseId": old["leaseId"]}
        initial = client.post("/api/onboarding/opening", json=owner)
        events = [
            json.loads(line[6:])
            for line in initial.text.splitlines()
            if line.startswith("data: ") and json.loads(line[6:]).get("t") == "sentence"
        ]
        full = "".join(e["text"] for e in events)
        seen = events[0]["text"][:3]
        assert (
            client.post(
                "/api/life/ack",
                json={
                    **owner,
                    "runId": events[0]["runId"],
                    "generation": events[0]["generation"],
                    "text": seen,
                },
            ).status_code
            == 200
        )
        fresh = client.post("/api/meeting/enter", json={**owner, "restore": True}).json()
        assert fresh["leaseId"] != old["leaseId"]
        assert fresh["epoch"] > old["epoch"]
        assert fresh["activation"] == "active"
        owner["leaseId"] = fresh["leaseId"]
        assert client.post("/api/life/ack", json={
            "clientId": owner["clientId"], "leaseId": old["leaseId"],
            "runId": events[0]["runId"], "generation": events[0]["generation"],
            "text": full,
        }).status_code == 409
        assert client.get("/api/onboarding").json()["pendingOpening"]
        response = client.post("/api/onboarding/opening", json=owner)
        resumed = [
            json.loads(line[6:])
            for line in response.text.splitlines()
            if line.startswith("data: ") and json.loads(line[6:]).get("t") == "sentence"
        ]
        remainder = "".join(e["text"] for e in resumed)
        assert seen + remainder == full
        assert resumed[0]["runId"] != events[0]["runId"]
        assert resumed[0]["generation"] != events[0]["generation"]
        assert (
            client.post(
                "/api/life/ack",
                json={
                    **owner,
                    "runId": resumed[0]["runId"],
                    "generation": resumed[0]["generation"],
                    "text": remainder,
                },
            ).status_code
            == 200
        )
        assert "".join(m["text"] for m in checkpoint.live_messages()) == full
        refreshed = client.post("/api/meeting/enter", json=owner).json()
        owner["leaseId"] = refreshed["leaseId"]
        assert not client.get("/api/onboarding").json()["pendingOpening"]
        assert (
            '"t": "sentence"'
            not in client.post("/api/onboarding/opening", json=owner).text
        )
        # A retired token is never a way to reactivate a later dormant runtime.
        assert client.post("/api/meeting/leave", json=owner).status_code == 200
        assert client.post("/api/meeting/enter", json={**owner, "restore": True}).status_code == 409


def test_closing_sse_iterator_releases_run_without_a_done_event(monkeypatch):
    from app.api import chat

    core = Coordinator()
    monkeypatch.setattr(chat, "runtime", core)
    monkeypatch.setattr(
        llm,
        "chat_stream",
        lambda *a, **k: iter([{"type": "text", "delta": "One. Two. Three."}]),
    )

    async def exercise():
        response = chat.chat(chat.ChatIn(text="hello", messageId="cancelled"))
        first = await anext(response.body_iterator)
        assert '"t": "sentence"' in first
        assert core.active is not None
        await response.body_iterator.aclose()
        assert core.active is None and core.queue == []

    asyncio.run(exercise())


def test_restored_queued_inbox_never_resumes_after_returning_to_daily(
    live_core, monkeypatch
):
    from app.services import archive

    core = live_core
    core.enter("client-one")
    pending = core.enqueue("virtual", "account", "archive-old", "old message")
    snapshot = archive.export_data()
    calls = []

    def reply(*a, **k):
        calls.append(1)
        yield {"type": "text", "delta": "Should not run."}

    monkeypatch.setattr(llm, "chat_stream", reply)
    with core.maintenance():
        archive.import_data(snapshot)
    fresh = core.enter("client-two")
    core.leave("client-two", fresh["leaseId"])
    time.sleep(0.3)
    assert calls == []
    assert (
        db.query("SELECT status FROM inbox WHERE id=?", (pending["id"],))[0]["status"]
        == "interrupted"
    )
