"""Native reasoning stays in request-local protocol state, never dialogue storage."""

import copy
import json

import pytest

from app.core import llm, state
from app.services import checkpoint, turn
from test_llm_stream import _patch

DS = {"url": "https://api.deepseek.com", "model": "deepseek-chat", "key": "test"}


def chunk(delta):
    return "data: " + json.dumps({"choices": [{"delta": delta}]})


@pytest.mark.parametrize("enabled", [False, True])
def test_deepseek_toggle_is_explicit_and_history_is_not_mutated(monkeypatch, enabled):
    seen = _patch(monkeypatch, ["data: [DONE]"])
    messages = [
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "hi"},
    ]
    list(
        llm.chat_stream(
            {**DS, "thinking": enabled}, messages, tools=[{"type": "function"}]
        )
    )
    assert seen[0]["payload"]["thinking"] == {
        "type": "enabled" if enabled else "disabled"
    }
    assert messages[0] == {"role": "assistant", "content": "old answer"}
    if enabled:
        assert seen[0]["payload"]["messages"][0]["reasoning_content"] == ""


@pytest.mark.parametrize(
    "url",
    [
        "https://compatible.test",
        "https://api.deepseek.com.evil.test",
        "https://api.deepseek.com@evil.test",
    ],
)
def test_unknown_provider_rejects_enabled_without_network(monkeypatch, url):
    seen = _patch(monkeypatch, [])
    with pytest.raises(llm.LlmError, match="thinking.*not supported"):
        list(llm.chat_stream({**DS, "url": url, "thinking": True}, []))
    assert seen == []
    list(llm.chat_stream({**DS, "url": url, "thinking": False}, []))
    assert "thinking" not in seen[0]["payload"]


def test_stream_reasoning_accumulates_privately_and_clears_previous_round(monkeypatch):
    _patch(
        monkeypatch,
        [
            chunk({"reasoning_content": "private "}),
            chunk({"reasoning_content": "thought", "content": "Hello."}),
            "data: [DONE]",
        ],
    )
    reasoning = {"reasoning_content": "stale"}
    events = list(
        llm.chat_stream({**DS, "thinking": True}, [], reasoning_out=reasoning)
    )
    assert events == [{"type": "text", "delta": "Hello."}]
    assert reasoning == {"reasoning_content": "private thought"}


def test_nonstream_reasoning_and_usage_are_separate(monkeypatch):
    seen = []

    def post(*args, **kwargs):
        seen.append(kwargs["json"])
        return llm.httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "Public",
                            "reasoning_content": "private",
                        }
                    }
                ],
                "usage": {"prompt_tokens": 9},
            },
        )

    monkeypatch.setattr(llm.httpx, "post", post)
    reasoning, usage = {}, {}
    result = llm.chat_completion(
        {**DS, "thinking": True}, [], usage_out=usage, reasoning_out=reasoning
    )
    assert result == {"role": "assistant", "content": "Public"}
    assert reasoning == {"reasoning_content": "private"}
    assert usage == {"prompt_tokens": 9}
    assert seen[0]["thinking"] == {"type": "enabled"}


def test_reasoning_only_stream_checks_cancellation_and_closes(monkeypatch):
    consumed = []

    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            consumed.append("closed")

        def iter_lines(self):
            for i in range(100):
                consumed.append(i)
                yield chunk({"reasoning_content": "private"})

    monkeypatch.setattr(llm.httpx, "stream", lambda *a, **k: Response())
    events = list(llm.chat_stream(DS, [], cancelled=lambda: len(consumed) >= 3))
    assert events == []
    assert consumed[-1] == "closed"
    assert len(consumed) < 6


def test_react_roundtrips_empty_and_multitool_reasoning_without_persisting(monkeypatch):
    cfg = state.load()
    cfg["settings"]["llm"] = {**DS, "thinking": True}
    state.write_state(cfg)
    snapshots = []

    def stream(*args, **kwargs):
        snapshots.append(copy.deepcopy(kwargs["json"]))
        from test_llm_stream import _Resp

        n = len(snapshots)
        if n < 3:
            return _Resp(
                [
                    chunk({"reasoning_content": "private" if n == 1 else ""}),
                    chunk(
                        {
                            "tool_calls": [
                                {
                                    "index": i,
                                    "id": f"call{n}-{i}",
                                    "function": {
                                        "name": "common_time",
                                        "arguments": "{}",
                                    },
                                }
                                for i in range(2)
                            ]
                        }
                    ),
                    "data: [DONE]",
                ]
            )
        return _Resp(
            [
                chunk({"reasoning_content": "final private", "content": "Hello."}),
                "data: [DONE]",
            ]
        )

    monkeypatch.setattr(llm.httpx, "stream", stream)
    events = list(turn.run_turn("Hi"))
    from test_loop import acknowledge_events

    acknowledge_events(events)
    assert [e["text"] for e in events if e["t"] == "sentence"] == ["Hello."]
    assistant = [m for m in snapshots[-1]["messages"] if m["role"] == "assistant"]
    assert [m["reasoning_content"] for m in assistant] == ["private", ""]
    assert "private" not in json.dumps(events)
    assert "private" not in json.dumps(checkpoint.live_messages())
    assert all("reasoning_content" not in m for m in turn.build_messages(cfg, "Again"))


def test_reasoning_only_completion_is_bounded_without_failed_history(monkeypatch):
    cfg = state.load()
    cfg["settings"]["llm"] = {**DS, "thinking": True}
    state.write_state(cfg)
    _patch(monkeypatch, [chunk({"reasoning_content": "private"}), "data: [DONE]"])
    events = list(turn.run_turn("Hi"))
    assert len(events) == 1 and events[0]["t"] == "error"
    assert "5 rounds" in events[0]["message"]
    assert checkpoint.live_messages() == []


def test_provider_stream_error_is_sanitized(monkeypatch):
    _patch(monkeypatch, ['data: {"error":{"message":"private provider detail"}}'])
    with pytest.raises(llm.LlmError, match="llm stream error") as caught:
        list(llm.chat_stream(DS, []))
    assert "private" not in str(caught.value)


def test_stream_timeout_during_reasoning_does_not_expose_reasoning(monkeypatch):
    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def iter_lines(self):
            yield chunk({"reasoning_content": "private"})
            raise llm.httpx.ReadTimeout("private exception")

    monkeypatch.setattr(llm.httpx, "stream", lambda *a, **k: Response())
    with pytest.raises(llm.LlmError, match="llm timeout") as caught:
        list(llm.chat_stream(DS, []))
    assert "private" not in str(caught.value)


def test_generation_change_during_reasoning_prevents_tools_and_output(monkeypatch):
    cfg = state.load()
    cfg["settings"]["llm"] = {**DS, "thinking": True}
    state.write_state(cfg)
    consumed = []

    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            consumed.append("closed")

        def iter_lines(self):
            yield chunk({"reasoning_content": "private"})
            checkpoint.interrupt_turn("", "")
            yield chunk({"reasoning_content": "private continuation"})
            raise AssertionError("stream should be closed after interrupt")

    monkeypatch.setattr(llm.httpx, "stream", lambda *a, **k: Response())
    assert list(turn.run_turn("Hi")) == []
    assert consumed == ["closed"]
    assert all(m["role"] == "user" for m in checkpoint.live_messages())


def test_interrupt_racing_stream_timeout_does_not_publish_stale_error(monkeypatch):
    class Response:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def iter_lines(self):
            checkpoint.interrupt_turn("", "")
            raise llm.httpx.ReadTimeout("private transport detail")
            yield

    monkeypatch.setattr(llm.httpx, "stream", lambda *a, **k: Response())
    cfg = state.load()
    cfg["settings"]["llm"] = DS
    state.write_state(cfg)
    assert list(turn.run_turn("Hi")) == []


def test_nonstream_tools_roundtrip_preserves_private_protocol_only_when_requested(
    monkeypatch,
):
    payloads = []

    def post(*args, **kwargs):
        payloads.append(copy.deepcopy(kwargs["json"]))
        message = {
            "role": "assistant",
            "content": None,
            "reasoning_content": "",
            "tool_calls": [
                {
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "common_time", "arguments": "{}"},
                }
            ],
        }
        return llm.httpx.Response(200, json={"choices": [{"message": message}]})

    monkeypatch.setattr(llm.httpx, "post", post)
    reasoning = {}
    tools = [{"type": "function"}]
    reply = llm.chat_completion(
        {**DS, "thinking": True}, [], tools, reasoning_out=reasoning
    )
    assert "reasoning_content" not in reply
    assert reasoning == {"reasoning_content": ""}
    llm.chat_completion({**DS, "thinking": True}, [{**reply, **reasoning}], tools)
    assert payloads[-1]["messages"][0]["reasoning_content"] == ""
    assert payloads[-1]["messages"][0]["tool_calls"][0]["id"] == "c1"
