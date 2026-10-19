"""llm.chat_stream：SSE 行解析、工具参数分片拼装、usage 回传。

主回合改流式后，这几件事是正确性的关键（分片拼装是同类项目的经典 bug）。
"""

from __future__ import annotations

from app.core import llm


class _Resp:
    """假的 httpx 流式响应：按行吐 SSE。"""

    def __init__(self, lines: list[str], status: int = 200) -> None:
        self.status_code = status
        self._lines = lines

    def iter_lines(self):
        yield from self._lines

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _patch(monkeypatch, lines: list[str], status: int = 200) -> list[dict]:
    seen: list[dict] = []

    def fake_stream(method, url, json=None, headers=None, timeout=None, **kw):
        seen.append({"url": url, "payload": json, "headers": headers or {}})
        return _Resp(lines, status)

    monkeypatch.setattr(llm.httpx, "stream", fake_stream)
    return seen


CFG = {"url": "http://llm.local", "model": "test-model", "key": "k"}


def test_text_deltas_are_yielded_in_order(monkeypatch):
    _patch(
        monkeypatch,
        [
            'data: {"choices":[{"delta":{"content":"你好"}}]}',
            'data: {"choices":[{"delta":{"content":"呀。"}}]}',
            "data: [DONE]",
        ],
    )
    evs = list(llm.chat_stream(CFG, []))
    assert [e["delta"] for e in evs if e["type"] == "text"] == ["你好", "呀。"]


def test_tool_call_arguments_are_assembled_across_fragments(monkeypatch):
    """参数分片下发：必须按 index 累积后再交给调用方（不能逐片解析）。"""
    _patch(
        monkeypatch,
        [
            'data: {"choices":[{"delta":{"content":"我查一下。"}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",'
            '"function":{"name":"memory_add","arguments":"{\\"content\\":"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
            '"function":{"arguments":"\\"喜欢草莓\\"}"}}]}}]}',
            "data: [DONE]",
        ],
    )
    evs = list(llm.chat_stream(CFG, []))
    calls = [e["calls"] for e in evs if e["type"] == "tool_calls"]
    assert len(calls) == 1
    assert calls[0][0]["id"] == "call_1"
    assert calls[0][0]["function"]["name"] == "memory_add"
    assert calls[0][0]["function"]["arguments"] == '{"content":"喜欢草莓"}'


def test_name_is_not_accumulated_twice(monkeypatch):
    """有些服务把 name 重复下发：应整体赋值而非拼接，否则函数名翻倍。"""
    _patch(
        monkeypatch,
        [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c",'
            '"function":{"name":"memory_add","arguments":"{}"}}]}}]}',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
            '"function":{"name":"memory_add"}}]}}]}',
            "data: [DONE]",
        ],
    )
    evs = list(llm.chat_stream(CFG, []))
    assert [e for e in evs if e["type"] == "tool_calls"][0]["calls"][0]["function"][
        "name"
    ] == "memory_add"


def test_usage_and_payload_shape(monkeypatch):
    seen = _patch(
        monkeypatch,
        [
            'data: {"choices":[{"delta":{"content":"好。"}}],'
            '"usage":{"prompt_tokens":42}}',
            "data: [DONE]",
        ],
    )
    usage: dict = {}
    list(llm.chat_stream(CFG, [], tools=[{"type": "function"}], usage_out=usage))
    assert usage == {"prompt_tokens": 42}
    # stream=true 且显式要 usage（否则很多兼容服务不返回）
    assert seen[0]["payload"]["stream"] is True
    assert seen[0]["payload"]["stream_options"] == {"include_usage": True}
    assert seen[0]["headers"]["Authorization"] == "Bearer k"


def test_http_error_raises_llm_error(monkeypatch):
    _patch(monkeypatch, [], status=500)
    try:
        list(llm.chat_stream(CFG, []))
    except llm.LlmError as e:
        assert "http 500" in str(e)
    else:  # pragma: no cover
        raise AssertionError("应抛 LlmError")


def test_missing_url_raises(monkeypatch):
    try:
        list(llm.chat_stream({"url": ""}, []))
    except llm.LlmError as e:
        assert "not configured" in str(e)
    else:  # pragma: no cover
        raise AssertionError("应抛 LlmError")
