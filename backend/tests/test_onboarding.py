import json
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core import db, state, llm
from app.services import onboarding, checkpoint, memory
from conftest import add_turn

client = TestClient(app)


def acknowledge_opening(events):
    seen = ""
    for event in events:
        seen += event["text"]
        checkpoint.acknowledge(event["runId"], seen, event["generation"])
    return events


def seen_opening():
    return acknowledge_opening(onboarding.opening(None))


def invalidate_generation():
    with db.tx() as c:
        c.execute("UPDATE sessions SET generation=generation+1 WHERE id='live'")


def configured():
    s = state.load()
    s["settings"]["llm"] = {"url": "https://example.test", "model": "test", "key": ""}
    state.write_state(s)


def decision(monkeypatch, action, name="", quote=""):
    monkeypatch.setattr(
        llm,
        "chat_completion",
        lambda *a, **k: {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "resolve",
                    "type": "function",
                    "function": {
                        "name": "first_meeting_result",
                        "arguments": json.dumps(
                            {"action": action, "name": name, "quote": quote}
                        ),
                    },
                }
            ],
        },
    )


def test_fresh_opening_once_and_resume():
    configured()
    assert onboarding.status()["stage"] == "new"
    first = client.post("/api/onboarding/opening", json={})
    assert first.status_code == 200
    assert "我该怎么称呼你" in first.text
    acknowledge_opening(
        [
            json.loads(line[6:])
            for line in first.text.splitlines()
            if line.startswith("data: ") and json.loads(line[6:]).get("t") == "sentence"
        ]
    )
    assert len(checkpoint.live_messages()) == 2
    assert all(x["role"] == "assistant" for x in checkpoint.live_messages())
    assert onboarding.status()["stage"] == "asking"
    assert "sentence" not in client.post("/api/onboarding/opening", json={}).text
    assert len(checkpoint.live_messages()) == 2


def test_unconfigured_does_not_claim_opening():
    assert client.post("/api/onboarding/opening", json={}).status_code == 409
    assert onboarding.status()["stage"] == "new"
    assert not checkpoint.live_messages()


def test_existing_player_is_not_new_but_default_pins_are():
    memory.add_memory("默认的世界设定", pinned=True)
    assert onboarding.status()["stage"] == "new"
    # A user who starts chatting before opening is handled by the new state;
    # a pre-existing installation has no onboarding meta at all.
    with db.tx() as c:
        c.execute("DELETE FROM meta WHERE key='first_meeting'")
    add_turn("你好", "你好呀")
    assert onboarding.status()["stage"] == "legacy"


def test_name_transaction_is_editable_and_idempotent(monkeypatch):
    configured()
    seen_opening()
    decision(monkeypatch, "name", "小羽", "叫我小羽")
    gen = checkpoint.generation()
    instruction = onboarding.resolve("叫我小羽", gen)
    assert "小羽" in instruction
    assert onboarding.status()["stage"] == "completed"
    rows = db.query("SELECT * FROM memories")
    assert len(rows) == 1 and rows[0]["pinned"] == 0
    assert "小羽" in rows[0]["content"]
    assert onboarding.resolve("叫我小羽", gen) is None
    assert len(db.query("SELECT * FROM memories")) == 1
    memory.delete_memory(rows[0]["id"])
    invalidate_generation()
    assert onboarding.status()["stage"] == "completed"


def test_hallucinated_name_rejected_and_failed_classifier_resumable(monkeypatch):
    configured()
    seen_opening()
    decision(monkeypatch, "name", "小羽", "叫我小羽")
    with pytest.raises(llm.LlmError):
        onboarding.resolve("我还没想好", checkpoint.generation())
    assert onboarding.status()["stage"] == "asking"
    assert not db.query("SELECT * FROM memories")


def test_clarify_once_then_skip_and_topic_exit(monkeypatch):
    configured()
    seen_opening()
    decision(monkeypatch, "clarify")
    onboarding.resolve("你猜", checkpoint.generation())
    assert onboarding.status()["stage"] == "clarifying"
    onboarding.resolve("再猜猜", checkpoint.generation())
    assert onboarding.status()["stage"] == "skipped"
    assert not db.query("SELECT * FROM memories")


def test_session_change_skips_and_stale_completion_cannot_write(monkeypatch):
    configured()
    seen_opening()
    gen = checkpoint.generation()
    invalidate_generation()
    assert onboarding.status()["stage"] == "skipped"
    decision(monkeypatch, "name", "小羽", "叫我小羽")
    assert onboarding.resolve("叫我小羽", gen) is None
    assert not db.query("SELECT * FROM memories")


def test_classifier_failure_releases_claim(monkeypatch):
    configured()
    seen_opening()

    def fail(*a, **k):
        raise llm.LlmError("llm timeout")

    monkeypatch.setattr(llm, "chat_completion", fail)
    with pytest.raises(llm.LlmError):
        onboarding.resolve("叫我小羽", checkpoint.generation())
    assert not onboarding.status()["busy"]


def test_model_timeout_leaves_no_failed_user_history(monkeypatch):
    configured()
    seen_opening()

    def fail(*a, **k):
        raise llm.LlmError("llm timeout")

    monkeypatch.setattr(llm, "chat_completion", fail)
    response = client.post("/api/chat", json={"text": "叫我小羽"})
    assert '"t": "error"' in response.text
    assert all(x["role"] == "assistant" for x in checkpoint.live_messages())
    assert onboarding.status()["stage"] == "asking"


def test_interrupt_opening_has_no_phantom_user_and_does_not_skip():
    configured()
    seen_opening()
    client.post("/api/chat/interrupt", json={"user": "", "assistant": "啊，你来了。"})
    assert [x["text"] for x in checkpoint.live_messages()] == ["啊，你来了。"]
    assert onboarding.status()["stage"] == "asking"


def test_stale_classifier_cannot_commit_after_interrupt(monkeypatch):
    configured()
    seen_opening()

    def interrupted(*a, **k):
        onboarding.interrupt_player("叫我小羽", "")
        return {
            "tool_calls": [
                {
                    "function": {
                        "name": "first_meeting_result",
                        "arguments": '{"action":"name","name":"小羽","quote":"叫我小羽"}',
                    }
                }
            ]
        }

    monkeypatch.setattr(llm, "chat_completion", interrupted)
    with pytest.raises(llm.LlmError):
        onboarding.resolve("叫我小羽", checkpoint.generation())
    assert not db.query("SELECT * FROM memories")
    assert onboarding.status()["stage"] == "asking"


def test_concurrent_opening_claim_is_atomic():
    from concurrent.futures import ThreadPoolExecutor

    configured()
    onboarding.status()
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: onboarding.opening(None), range(2)))
    assert sorted(map(len, results)) == [0, 2]
    for events in results:
        acknowledge_opening(events)
    assert len(checkpoint.live_messages()) == 2


def test_memory_failure_rolls_back_completion(monkeypatch):
    configured()
    seen_opening()
    decision(monkeypatch, "name", "小羽", "叫我小羽")
    with db.tx() as c:
        c.execute(
            "CREATE TRIGGER reject_name BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'disk write failed'); END"
        )
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        onboarding.resolve("叫我小羽", checkpoint.generation())
    assert onboarding.status()["stage"] == "asking"
    assert not onboarding.status()["busy"]
    assert not db.query("SELECT * FROM memories")


def test_interrupt_before_opening_request_cannot_create_late_opening():
    configured()
    onboarding.status()
    client.post("/api/chat/interrupt", json={"user": "", "assistant": ""})
    assert onboarding.opening(None) == []
    assert not checkpoint.live_messages()
    assert onboarding.status()["stage"] == "asking"


def test_stale_interrupt_after_new_session_never_resurrects_greeting():
    configured()
    seen_opening()
    invalidate_generation()
    onboarding.interrupt_opening("啊，你来了。")
    assert onboarding.status()["stage"] == "skipped"
    assert len(checkpoint.live_messages()) == 2


def test_early_name_suppresses_late_opening(monkeypatch):
    configured()
    onboarding.status()
    decision(monkeypatch, "name", "小羽", "叫我小羽")
    onboarding.resolve("叫我小羽", checkpoint.generation(), allow_new=True)
    assert onboarding.status()["stage"] == "completed"
    assert onboarding.opening(None) == []


def test_unheard_clarification_is_restored_after_reply_failure(monkeypatch):
    configured()
    seen_opening()
    decision(monkeypatch, "clarify")

    def fail(*a, **k):
        raise llm.LlmError("reply failed")
        yield

    monkeypatch.setattr(llm, "chat_stream", fail)
    client.post("/api/chat", json={"text": "你猜"})
    assert onboarding.status()["stage"] == "asking"


def test_delayed_interrupt_carries_generation_and_cannot_write_to_new_session():
    configured()
    seen_opening()
    gen = checkpoint.generation()
    invalidate_generation()
    assert onboarding.status()["stage"] == "skipped"
    client.post(
        "/api/chat/interrupt",
        json={"generation": gen, "user": "叫我小羽", "assistant": "你好"},
    )
    assert len(checkpoint.live_messages()) == 2


def test_interrupt_returns_authoritative_generation_for_next_turn():
    configured()
    seen_opening()
    gen = checkpoint.generation()
    first = client.post(
        "/api/chat/interrupt", json={"user": "", "assistant": "啊", "generation": gen}
    )
    updated = int(first.headers["x-momo-generation"])
    assert updated == gen + 1
    second = client.post(
        "/api/chat/interrupt",
        json={"user": "叫我小羽", "assistant": "", "generation": updated},
    )
    assert int(second.headers["x-momo-generation"]) == updated + 1
    assert onboarding.status()["stage"] == "asking"


def test_session_switch_during_prompt_build_cannot_land_old_turn(monkeypatch):
    from app.services import turn

    configured()
    seen_opening()
    original = turn.build_messages

    def switching(*args, **kwargs):
        messages = original(*args, **kwargs)
        invalidate_generation()
        return messages

    monkeypatch.setattr(turn, "build_messages", switching)
    monkeypatch.setattr(
        llm,
        "chat_stream",
        lambda *args, **kwargs: iter([{"type": "text", "delta": "旧现场的回复。"}]),
    )
    list(turn.run_turn("你好", first_meeting=True))
    assert len(checkpoint.live_messages()) == 2
