"""One activated brain, actual presentation ownership, and private peer context."""

import threading
import time

import pytest

from app.core import db
from app.services import checkpoint, memory, turn
from app.services.coordinator import Coordinator, CoordinationError


def test_runtime_starts_dormant_and_title_leave_never_enables_background(monkeypatch):
    monkeypatch.setenv("MOMO_TEST_VIRTUAL", "1")
    core = Coordinator()
    core.start()
    try:
        assert core.snapshot()["activation"] == "dormant"
        lease = core.enter("client-one")
        assert core.snapshot()["activation"] == "active"
        core.leave("client-one", lease["leaseId"])
        assert core.snapshot()["activation"] == "dormant"
    finally:
        core.close()


def test_presentation_owns_attention_until_bound_completion():
    core = Coordinator()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    with core.run("local", client="client-one", lease="lease"):
        token = core.present("local", 0)
    assert core.snapshot()["activity"]["phase"] == "presenting"
    acquired = threading.Event()

    def phone():
        with core.run("phone", source="qq"):
            acquired.set()

    thread = threading.Thread(target=phone)
    thread.start()
    assert not acquired.wait(.1)
    with pytest.raises(CoordinationError):
        core.complete_presentation("client-one", "lease", "local", "wrong", 0)
    core.complete_presentation("client-one", "lease", "local", token, 0)
    assert acquired.wait(1)
    thread.join(1)


def test_late_streamed_sentence_keeps_the_paused_presentation_capability():
    core = Coordinator()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    gen = checkpoint.generation()
    with core.run("local", client="client-one", lease="lease"):
        first = core.present("local", gen)
        core.complete_presentation("client-one", "lease", "local", first, gen, "stopped")
        assert core.presentation is None
        assert first in core.paused_presentations
        later = core.present("local", gen)
        assert later == first
        assert core.presentation is None
    # The model has finished streaming. The same token can now reacquire and
    # complete; no second live token can pin attention indefinitely.
    core.complete_presentation("client-one", "lease", "local", later, gen, "resume")
    assert core.presentation["token"] == first
    core.complete_presentation("client-one", "lease", "local", first, gen)
    assert core.presentation is None
    assert not core.paused_presentations


def test_interrupt_retires_a_paused_presentation(monkeypatch):
    from app.api import chat
    core = Coordinator()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    monkeypatch.setattr(chat, "runtime", core)
    gen = checkpoint.generation()
    checkpoint.begin_turn("hello", gen, "at", run_id="local")
    checkpoint.append_sentence("partial answer", gen, "at")
    with core.run("local", client="client-one", lease="lease"):
        token = core.present("local", gen)
        core.complete_presentation("client-one", "lease", "local", token, gen, "stopped")
    assert token in core.paused_presentations
    chat.interrupt(chat.InterruptIn(
        clientId="client-one", leaseId="lease", runId="local",
        generation=gen, user="hello", assistant="",
    ))
    assert token not in core.paused_presentations
    with pytest.raises(CoordinationError):
        core.complete_presentation("client-one", "lease", "local", token, gen, "resume")


def test_focus_and_phone_pause_are_independent_idempotent_policy():
    core = Coordinator()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    core.control("client-one", "lease", "one", "stop")
    core.control("client-one", "lease", "two", "focus_on")
    core.control("client-one", "lease", "three", "focus_off")
    assert core.snapshot()["phonePaused"] is True
    core.control("client-one", "lease", "four", "resume_phone")
    assert not core.snapshot()["phonePaused"]
    core.control("client-one", "lease", "four", "resume_phone")
    with pytest.raises(CoordinationError):
        core.control("other-client", "lease", "five", "use_phone")


def test_focus_clears_on_title_while_phone_pause_survives_new_boot(monkeypatch):
    monkeypatch.setenv("MOMO_TEST_VIRTUAL", "1")
    core = Coordinator()
    core.start()
    try:
        first = core.enter("client-one")
        core.control("client-one", first["leaseId"], "pause", "stop")
        core.control("client-one", first["leaseId"], "focus", "focus_on")
        core.leave("client-one", first["leaseId"])
        assert core.snapshot()["activation"] == "dormant"
        assert core.snapshot()["focus"] is False
        assert core.snapshot()["phonePaused"] is True
        assert db.meta_get("attention_policy") == '{"focus": false, "phonePaused": true}'
        second = core.enter("client-two")
        assert second["focus"] is False
        assert second["phonePaused"] is True
    finally:
        core.close()


def test_inbox_identity_includes_peer_even_when_external_id_is_equal():
    core = Coordinator()
    one = core.enqueue("qq", "account", "same", "one", peer_id="alice")
    two = core.enqueue("qq", "account", "same", "two", peer_id="bob")
    assert one["id"] != two["id"]
    assert core.enqueue("qq", "account", "same", "one", peer_id="alice")["acceptedNew"] is False


def test_peer_context_and_memories_do_not_leak_across_audiences():
    gen = checkpoint.generation()
    checkpoint.begin_turn("owner secret", gen, "one", run_id="owner")
    checkpoint.append_sentence("private reply", gen, "one")
    checkpoint.acknowledge("owner", "private reply", gen)
    checkpoint.finish_turn(gen, "one")
    owner_memory = memory.add_memory("owner private pin", pinned=True)
    with checkpoint.audience_scope("social:qq:account:alice"), memory.audience_scope("social:qq:account:alice"):
        assert checkpoint.context_messages() == []
        assert memory.pins() == []
        assert memory.search_memories("owner private") == []
        with pytest.raises(memory.MemoryError):
            memory.update_memory(owner_memory["id"], "overwrite")
        checkpoint.begin_turn("alice says hello", gen, "two", run_id="alice", source="qq")
        checkpoint.append_sentence("hello alice", gen, "two")
        assert checkpoint.acknowledge("alice", "hello alice", gen)
        checkpoint.finish_turn(gen, "two")
        memory.add_memory("alice enjoys tea", pinned=True)
        assert memory.pins() == ["alice enjoys tea"]
        assert [m["text"] for m in checkpoint.context_messages()] == ["alice says hello", "hello alice"]
    assert memory.pins() == ["owner private pin"]
    assert [m["text"] for m in checkpoint.context_messages()] == ["owner secret", "private reply"]


def test_local_display_ack_cannot_commit_social_reply():
    gen = checkpoint.generation()
    checkpoint.begin_turn("hi", gen, "social", run_id="social", source="qq")
    checkpoint.append_sentence("outbound", gen, "social")
    assert not checkpoint.acknowledge("social", "outbound", gen, source="meeting")


def test_external_input_is_recorded_as_received_even_when_generation_fails():
    gen = checkpoint.generation()
    checkpoint.begin_turn("real incoming", gen, "social", run_id="social", source="qq")
    checkpoint.discard_unanswered_turn(gen, "social")
    assert checkpoint.live_messages()[0]["text"] == "real incoming"


def test_remote_contact_cannot_control_focus_even_when_it_is_owner_bound(monkeypatch):
    from app.services import coordinator, capability
    core = Coordinator()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    monkeypatch.setattr(coordinator, "runtime", core)
    with core.run("remote", source="qq"):
        token = coordinator.current_run.set("remote")
        try:
            result = capability.execute_tool("attention_control", {"action": "focus_on"})
        finally:
            coordinator.current_run.reset(token)
    assert "Only the current local" in result
    assert not core.focus


def test_old_restoration_token_cannot_boot_a_dormant_runtime():
    core = Coordinator()
    core.started = True
    with pytest.raises(CoordinationError, match="Boot"):
        core.enter("client-one", "old-lease", restore=True)
    assert core.mode == "dormant"


def test_isolated_summary_does_not_contaminate_owner_projection():
    from app.core import state, llm
    from app.services import compress
    gen = checkpoint.generation()
    with checkpoint.audience_scope("social:alice"):
        for i in range(4):
            at = "time-" + str(i)
            checkpoint.begin_turn("alice " + str(i), gen, at, source="qq")
            checkpoint.append_sentence("answer", gen, at)
            checkpoint.acknowledge(checkpoint.current_run(gen, at), "answer", gen)
            checkpoint.finish_turn(gen, at)
        with db.tx() as c:
            c.execute("INSERT INTO audience_summaries(audience,summary,cursor,version) VALUES('social:alice','alice private summary',1,0)")
        assert checkpoint.live_summary() == "alice private summary"
    assert checkpoint.live_summary() == ""


def test_forgetting_peer_memory_invalidates_that_peers_summary():
    with checkpoint.audience_scope("social:alice"), memory.audience_scope("social:alice"):
        checkpoint.summary_state()
        item = memory.add_memory("alice old private detail")
        with db.tx() as c:
            c.execute("INSERT INTO audience_summaries(audience,summary,cursor,version) VALUES('social:alice','old private detail',1,0)")
        memory.delete_memory(item["id"])
        assert checkpoint.live_summary() == ""


def test_presentation_completion_requires_full_generated_reply(monkeypatch):
    from fastapi import HTTPException
    from app.api import meeting
    core = Coordinator()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    monkeypatch.setattr(meeting, "runtime", core)
    gen = checkpoint.generation()
    checkpoint.begin_turn("hi", gen, "at", run_id="local")
    checkpoint.append_sentence("Long complete answer.", gen, "at")
    checkpoint.finish_turn(gen, "at")
    with core.run("local", client="client-one", lease="lease"):
        token = core.present("local", gen)
    with pytest.raises(HTTPException):
        meeting.presentation(meeting.PresentationAckIn(clientId="client-one", leaseId="lease", runId="local", token=token, generation=gen, outcome="completed", text="Long"))
    assert core.presentation is not None


def test_fault_heartbeat_retains_only_ownership_until_explicit_human_recovery():
    core = Coordinator()
    core.started = True
    core.mode = "paused"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    assert core.heartbeat("client-one", "lease")["activation"] == "fault"
    with pytest.raises(CoordinationError):
        core.require_meeting("client-one", "lease")
    assert core.recover_attention()["activation"] == "active"


def test_recovery_without_valid_owner_never_boots_momo():
    core = Coordinator()
    core.started = True
    core.mode = "paused"
    assert core.recover_attention()["activation"] == "dormant"


def test_summary_inference_waits_for_the_same_brain_lock(monkeypatch):
    from app.core import llm
    from app.services import compress, coordinator
    core = Coordinator()
    monkeypatch.setattr(coordinator, "runtime", core)
    called = threading.Event()
    for i in range(4):
        gen = checkpoint.generation()
        at = "summary-" + str(i)
        checkpoint.begin_turn("question", gen, at)
        checkpoint.append_sentence("answer", gen, at)
        checkpoint.acknowledge(checkpoint.current_run(gen, at), "answer", gen)
        checkpoint.finish_turn(gen, at)
    monkeypatch.setattr(llm, "chat_completion", lambda *a, **k: (called.set() or {"content": "summary"}))
    with core.reasoning_lock:
        thread = threading.Thread(target=compress.compress_once)
        thread.start()
        assert not called.wait(.1)
    thread.join(1)
    assert called.is_set()


def test_safe_phone_retry_preserves_one_received_input_and_hides_old_generated_text():
    gen = checkpoint.generation()
    checkpoint.begin_turn("incoming", gen, "first", run_id="old", source="qq")
    checkpoint.append_sentence("never sent", gen, "first")
    checkpoint.finish_turn(gen, "first", "interrupted")
    assert checkpoint.begin_turn("incoming", gen, "again", run_id="retry", source="qq", retry_of="old")
    checkpoint.append_sentence("actual reply", gen, "again")
    checkpoint.acknowledge("retry", "actual reply", gen)
    checkpoint.finish_turn(gen, "again")
    assert [m["text"] for m in checkpoint.live_messages()] == ["incoming", "actual reply"]
    assert len(db.query("SELECT * FROM messages WHERE role='user'")) == 1


def test_known_external_receipt_commits_original_reply_after_epoch_cancellation():
    import hashlib, json
    core = Coordinator()
    core.schema()
    gen = checkpoint.generation()
    checkpoint.begin_turn("incoming", gen, "original", run_id="original", source="qq")
    checkpoint.append_sentence("sent reply", gen, "original")
    checkpoint.finish_turn(gen, "original")
    payload = {"method": "channels.send", "textHash": hashlib.sha256(b"sent reply").hexdigest()}
    with db.tx() as c:
        c.execute("UPDATE sessions SET generation=generation+1 WHERE id='live'")
        c.execute("INSERT INTO outbox VALUES('command','original',0,'completed',?,'{}',?)", (json.dumps(payload), db.now_iso()))
    assert checkpoint.acknowledge_external("original", "sent reply", "command")
    assert [m["text"] for m in checkpoint.live_messages()] == ["incoming", "sent reply"]
    assert not checkpoint.acknowledge_external("original", "forged", "command")


def test_history_replay_needs_its_own_attention_permit():
    core = Coordinator()
    core.started = True
    core.mode = "meeting"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    gen = checkpoint.generation()
    checkpoint.begin_turn("hi", gen, "time", run_id="history")
    checkpoint.append_sentence("shown", gen, "time")
    checkpoint.acknowledge("history", "shown", gen)
    checkpoint.finish_turn(gen, "time")
    event = next(m for m in checkpoint.live_messages() if m["role"] == "assistant")
    permit = core.replay("client-one", "lease", "history", event["eventId"])
    assert permit["presentation"]["runId"] == "history"
    assert core.snapshot()["activity"]["phase"] == "presenting"
    with pytest.raises(CoordinationError):
        core.replay("client-one", "lease", "history", event["eventId"])


def test_local_interruption_resumes_only_unsent_phone_work_in_one_brain(monkeypatch):
    from app.core import llm
    from app.services.social import social
    core = Coordinator()
    core.start()
    account = social.put("qq", {"enabled": True, "accountId": "qq-main", "expectedSelfId": "10001", "endpoint": "ws://127.0.0.1:3001", "token": "fixture-only", "permissions": {"receive": True, "reply": True}})
    started, sent = threading.Event(), threading.Event()
    prompts = []
    original_request = core.host.request

    def provider(*args, **kwargs):
        prompts.append(args[1][-1]["content"])
        if len(prompts) == 1:
            started.set()
            for _ in range(150):
                if kwargs["cancelled"]():
                    return
                time.sleep(.01)
        yield {"type": "text", "delta": "hello" if prompts[-1] == "local hello" else "remote answer"}

    def transport(method, params=None, **kwargs):
        if method == "channels.send":
            sent.set()
            return {"receipt": {**params["permit"], "status": "completed", "accountId": "qq-main", "peerId": "20002", "pluginId": "momo-qq", "evidence": "fixture-accepted"}}
        return original_request(method, params, **kwargs)

    monkeypatch.setattr(llm, "chat_stream", provider)
    monkeypatch.setattr(core.host, "request", transport)
    try:
        lease = core.enter("client-one")
        incoming = {"source": "qq", "pluginId": "momo-qq", "accountId": "qq-main", "selfId": "10001", "peerId": "20002", "senderId": "20002", "conversationKind": "private", "externalMessageId": "one", "text": "remote question", "policyRevision": account["policyRevision"]}
        core.event("inbox", incoming)
        assert started.wait(1)
        core.prepare_local("client-one", lease["leaseId"])
        with core.run("local", client="client-one", lease=lease["leaseId"]):
            events = list(turn.run_turn("local hello", run_id="local"))
            sentence = next(e for e in events if e["t"] == "sentence")
            token = core.present("local", sentence["generation"])
        assert not sent.is_set()
        checkpoint.acknowledge("local", "hello", sentence["generation"])
        core.complete_presentation("client-one", lease["leaseId"], "local", token, sentence["generation"])
        assert sent.wait(2)
        deadline = time.monotonic() + 2
        while core.active and time.monotonic() < deadline:
            time.sleep(.01)
        assert prompts == ["remote question", "local hello", "remote question"]
        assert len(db.query("SELECT * FROM messages WHERE role='user' AND text='remote question'")) == 1
        assert db.query("SELECT status FROM inbox WHERE source='qq'")[0]["status"] == "completed"
    finally:
        core.close()


def test_user_phone_pause_survives_restart_and_boot_until_explicit_resume(monkeypatch):
    core = Coordinator()
    core.start()
    lease = core.enter("client-one")
    core.control("client-one", lease["leaseId"], "stop", "stop")
    core.close()
    replacement = Coordinator()
    replacement.start()
    try:
        assert replacement.snapshot()["activation"] == "dormant"
        lease = replacement.enter("client-two")
        assert replacement.snapshot()["phonePaused"] is True
        replacement.control("client-two", lease["leaseId"], "resume", "resume_phone")
        assert not replacement.snapshot()["phonePaused"]
    finally:
        replacement.close()


def test_owner_can_return_to_title_from_fault_without_waiting_for_lease_expiry():
    core = Coordinator()
    core.schema()
    core.started = True
    core.mode = "paused"
    core.owner = {"clientId": "client-one", "leaseId": "lease", "expiresAt": time.monotonic() + 10}
    core.leave("client-one", "lease")
    assert core.owner is None
    assert core.snapshot()["activation"] == "dormant"


def test_stale_mcp_reconcile_cannot_resurrect_configs_on_social_refresh(monkeypatch):
    from app.services.social import social
    core = Coordinator()
    configurations = []

    class Host:
        def request(self, method, params, **kwargs):
            configurations.append(params)
            return {"ok": True}

    core.host = Host()
    monkeypatch.setattr(social, "host_configs", lambda: [])
    fresh = [{"id": "fresh", "type": "mcp"}]
    core.configure_host_plugins(fresh, revision=2)
    core.configure_host_plugins([{"id": "retired", "type": "mcp"}], revision=1)
    core.refresh_social_plugins()
    assert configurations[-1]["plugins"] == fresh
    versions = [item["configurationRevision"] for item in configurations]
    assert versions == sorted(set(versions))
