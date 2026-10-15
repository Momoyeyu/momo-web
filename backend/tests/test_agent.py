"""ReAct loop：llm mock（首轮 tool_call → 次轮文本）、error 路径、history 落盘。"""
from __future__ import annotations

import json

from app import agent, llm, store


def _tool_call(name: str, args: str = "{}", call_id: str = "call_1"):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": args},
    }


def test_react_tool_then_text(monkeypatch):
    seen_messages = []

    def fake_chat(llm_cfg, messages, tools=None):
        seen_messages.append(list(messages))
        assert tools  # tools 声明已传
        if len(seen_messages) == 1:
            return {
                "role": "assistant",
                "content": None,
                "tool_calls": [_tool_call("common_time")],
            }
        return {"role": "assistant", "content": "你好呀。#happy 今天很开心！"}

    monkeypatch.setattr(llm, "chat_completion", fake_chat)

    events = list(agent.run_turn("在吗"))
    deltas = [e["text"] for e in events if e["t"] == "delta"]
    # 按标点切段、保留标点
    assert deltas == ["你好呀。", "#happy 今天很开心！"]

    # 第二轮 messages 带 tool 结果（common_time → iso+tz JSON）
    tool_msgs = [m for m in seen_messages[-1] if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0]["tool_call_id"] == "call_1"
    payload = json.loads(tool_msgs[0]["content"])
    assert "iso" in payload and "tz" in payload

    # history 追加并落盘（指令/旧 #tag 已剥离，SSE delta 仍推原始文本）
    h = store.get_state()["history"]
    assert [m["role"] for m in h] == ["user", "assistant"]
    assert h[0]["text"] == "在吗"
    assert h[1]["text"] == "你好呀。今天很开心！"


def test_llm_error_yields_error_event(monkeypatch):
    def fake_chat(llm_cfg, messages, tools=None):
        raise llm.LlmError("llm unreachable")

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    events = list(agent.run_turn("hi"))
    assert events == [
        {"t": "error", "message": "llm unreachable", "service": "llm"}
    ]


def test_max_rounds_without_content(monkeypatch):
    def fake_chat(llm_cfg, messages, tools=None):
        return {
            "role": "assistant",
            "content": None,
            "tool_calls": [_tool_call("common_time")],
        }

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    events = list(agent.run_turn("hi"))
    assert len(events) == 1
    assert events[0]["t"] == "error"
    assert "5 rounds" in events[0]["message"]


def test_tool_memory_ops_via_react(monkeypatch):
    """tool_call 走真实 memory 层：add 成功、delete 未知 id 返回说明文本。"""
    rounds = []

    def fake_chat(llm_cfg, messages, tools=None):
        rounds.append(list(messages))
        n = len(rounds)
        if n == 1:
            return {
                "role": "assistant",
                "content": None,
                "tool_calls": [_tool_call("memory_add", '{"content": "用户喜欢草莓"}', "c1")],
            }
        if n == 2:
            return {
                "role": "assistant",
                "content": None,
                "tool_calls": [_tool_call("memory_delete", '{"id": "nope"}', "c2")],
            }
        return {"role": "assistant", "content": "记好了！"}

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    events = list(agent.run_turn("帮我记一下"))
    assert [e for e in events if e["t"] == "delta"] == [
        {"t": "delta", "text": "记好了！"}
    ]

    tool_msgs = [m for m in rounds[-1] if m.get("role") == "tool"]
    assert json.loads(tool_msgs[0]["content"])["ok"] is True
    assert "不存在" in tool_msgs[1]["content"]

    from app import memory

    assert memory.list_memories()[0]["content"] == "用户喜欢草莓"


def test_tool_memory_update_dispatch():
    """memory_update 走 edit_memory：更新成功 / pin:* → not_found 说明文本。"""
    from app import memory
    from app.agent.tools import run_call

    mem = memory.add_memory("旧事实")
    msg = run_call(
        _tool_call(
            "memory_update",
            json.dumps({"id": mem["id"], "content": "新事实"}),
            "c1",
        ),
        pins=[],
    )
    assert json.loads(msg["content"])["ok"] is True
    assert memory.list_memories()[0]["content"] == "新事实"

    msg = run_call(
        _tool_call("memory_update", '{"id": "pin:abc", "content": "x"}', "c2"),
        pins=[],
    )
    assert "不存在" in msg["content"]
