"""The model sees the actual current channel, independently of memory ownership."""

import copy

import pytest

from app.core import llm
from app.services import checkpoint, prompt, turn


def capture(monkeypatch, *, source="qq", audience="owner", **kwargs):
    seen = []

    def provider(_config, messages, tools=None, **_kwargs):
        seen.append((copy.deepcopy(messages), copy.deepcopy(tools)))
        yield {"type": "text", "delta": "测试回复。"}

    monkeypatch.setattr(llm, "chat_stream", provider)
    events = list(turn.run_turn("你知道现在通过什么聊天吗？", source=source, audience=audience, **kwargs))
    assert not [event for event in events if event["t"] == "error"]
    return seen[0]


def contribution(source="qq"):
    return {"pluginId": "momo-" + source, "source": source, "scope": "current_turn",
            "sections": [{"id": source + "-private-chat", "content": "Your reply is automatically delivered to this same private conversation."}]}


def test_linked_owner_qq_turn_identifies_actual_channel(monkeypatch):
    messages, tools = capture(monkeypatch)
    systems = "\n".join(m["content"] for m in messages if m["role"] == "system")
    assert "Current reply channel: QQ" in systems
    assert "use attention_control" not in systems
    assert "attention_control" not in {item["function"]["name"] for item in tools}
    assert prompt.load_soul() in messages[0]["content"]


def test_current_plugin_context_reaches_provider_after_history(monkeypatch):
    gen = checkpoint.generation()
    checkpoint.begin_turn("old message", gen, "past", source="qq")
    checkpoint.append_sentence("I was using another app.", gen, "past")
    checkpoint.acknowledge(checkpoint.current_run(gen, "past"), "I was using another app.", gen)
    messages, _ = capture(monkeypatch, plugin_context=contribution())
    assert messages[-1]["role"] == "user"
    assert "Current reply channel: QQ" in messages[-2]["content"]
    assert "automatically delivered" in messages[-2]["content"]
    assert next(i for i, m in enumerate(messages) if m["role"] == "assistant") < len(messages) - 2


@pytest.mark.parametrize("source", ["wechat", "unrecognized"])
def test_retired_source_cannot_create_current_turn_or_plugin_context(monkeypatch, source):
    from app.core import db
    from app.services.turn_context import validate_plugin_context
    called = []
    monkeypatch.setattr(llm, "chat_stream", lambda *a, **k: called.append(True))
    with pytest.raises(ValueError, match="Unsupported"):
        list(turn.run_turn("old queued input", source=source, plugin_context=contribution(source)))
    with pytest.raises(ValueError):
        validate_plugin_context(contribution(source), source)
    assert called == []
    assert db.query("SELECT * FROM messages") == []


def test_local_turn_does_not_inherit_previous_channel_or_lose_controls(monkeypatch):
    capture(monkeypatch, plugin_context=contribution())
    messages, tools = capture(monkeypatch, source="meeting")
    assert "Current reply channel: chat" in messages[-2]["content"]
    assert "momo-qq" not in "\n".join(m["content"] for m in messages if m["role"] == "system")
    assert "attention_control" in {item["function"]["name"] for item in tools}


def test_remote_channel_never_enables_live_performance_even_for_owner(monkeypatch):
    presentation = {"expressions": [{"name": "happy", "desc": "smile"}], "motions": [],
                    "expressionState": {"name": None, "intensity": 0}}
    messages, _ = capture(monkeypatch, presentation=presentation)
    text = "\n".join(m["content"] for m in messages if m["role"] == "system")
    assert "Performance direction" not in text
    assert "Live performance mode" not in text


def test_remote_nonowner_retains_memory_isolation_and_channel(monkeypatch):
    messages, _ = capture(monkeypatch, audience="social:separate")
    text = "\n".join(m["content"] for m in messages if m["role"] == "system")
    assert "Current reply channel: QQ" in text
    assert "separate contact" in text


@pytest.mark.parametrize("bad", [
    {**contribution(), "source": "wechat"},
    {**contribution(), "pluginId": "other-plugin"},
    {**contribution(), "scope": "permanent"},
    {**contribution(), "token": "must-never-enter-model"},
    {**contribution(), "sections": [{"id": "channel", "content": "x" * 4001}]},
])
def test_mismatched_or_unbounded_plugin_context_is_rejected_before_model(monkeypatch, bad):
    called = []
    monkeypatch.setattr(llm, "chat_stream", lambda *a, **k: called.append(True))
    with pytest.raises(ValueError):
        list(turn.run_turn("hello", source="qq", plugin_context=bad))
    assert not called
