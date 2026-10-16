"""ReAct loop：llm mock（首轮 tool_call → 次轮文本）、error 路径、history 落盘。"""
from __future__ import annotations

import json

from app.core import llm
from app.services import checkpoint, turn


def _tool_call(name: str, args: str = "{}", call_id: str = "call_1"):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": args},
    }


def test_react_tool_then_text(monkeypatch):
    seen_messages = []

    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
        seen_messages.append(list(messages))
        assert tools  # tools 声明已传
        if len(seen_messages) == 1:
            return {
                "role": "assistant",
                "content": None,
                "tool_calls": [_tool_call("common_time")],
            }
        return {"role": "assistant", "content": "你好呀。<exp>开心</exp>今天很开心！"}

    monkeypatch.setattr(llm, "chat_completion", fake_chat)

    events = list(turn.run_turn("在吗"))

    # 句事件：唯一口径切句，正文剥离指令，指令随 dirs 下发
    sents = [e for e in events if e["t"] == "sentence"]
    assert [(e["no"], e["text"]) for e in sents] == [
        (0, "你好呀。"),
        (1, "今天很开心！"),
    ]
    assert sents[0]["dirs"] == []
    assert [(d["kind"], d["name"], d["offset"]) for d in sents[1]["dirs"]] == [
        ("exp", "开心", 0)
    ]
    # 过渡期兼容：给旧前端发一次完整原文（含指令），行为与改造前一致
    assert [e["text"] for e in events if e["t"] == "delta"] == [
        "你好呀。<exp>开心</exp>今天很开心！"
    ]

    # 第二轮 messages 带 tool 结果（common_time → utc+tz JSON）
    tool_msgs = [m for m in seen_messages[-1] if m.get("role") == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0]["tool_call_id"] == "call_1"
    payload = json.loads(tool_msgs[0]["content"])
    assert "utc" in payload and "tz" in payload

    # 句级落账：一回合两句 = 两行 assistant（回合边界由其后的 user 行界定）
    h = checkpoint.live_messages()
    assert [m["role"] for m in h] == ["user", "assistant", "assistant"]
    assert h[0]["text"] == "在吗"
    assert h[1]["text"] == "你好呀。"
    assert h[2]["text"] == "今天很开心！"


def test_llm_error_yields_error_event(monkeypatch):
    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
        raise llm.LlmError("llm unreachable")

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    events = list(turn.run_turn("hi"))
    assert events == [
        {"t": "error", "message": "llm unreachable", "service": "llm"}
    ]


def test_max_rounds_without_content(monkeypatch):
    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
        return {
            "role": "assistant",
            "content": None,
            "tool_calls": [_tool_call("common_time")],
        }

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    events = list(turn.run_turn("hi"))
    assert len(events) == 1
    assert events[0]["t"] == "error"
    assert "5 rounds" in events[0]["message"]


def test_tool_memory_ops_via_react(monkeypatch):
    """tool_call 走真实 memory 层：add 成功、delete 未知 id 返回说明文本。"""
    rounds = []

    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
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
    events = list(turn.run_turn("帮我记一下"))
    assert [e for e in events if e["t"] == "delta"] == [
        {"t": "delta", "text": "记好了！"}
    ]

    tool_msgs = [m for m in rounds[-1] if m.get("role") == "tool"]
    assert json.loads(tool_msgs[0]["content"])["ok"] is True
    assert "不存在" in tool_msgs[1]["content"]

    from app.services import memory

    assert memory.list_memories()[0]["content"] == "用户喜欢草莓"


def test_tool_memory_update_dispatch():
    """memory_update 走 edit_memory：更新成功 / pinned 行 → 拒绝文本。"""
    from app.services import memory
    from app.services.capability import run_call

    mem = memory.add_memory("旧事实")
    msg = run_call(
        _tool_call(
            "memory_update",
            json.dumps({"id": mem["id"], "content": "新事实"}),
            "c1",
        ),
    )
    assert json.loads(msg["content"])["ok"] is True
    assert memory.list_memories()[0]["content"] == "新事实"

    pin = memory.add_memory("用户叫夜羽", pinned=True)
    msg = run_call(
        _tool_call(
            "memory_update",
            json.dumps({"id": pin["id"], "content": "x"}),
            "c2",
        ),
    )
    assert "pin" in msg["content"]


def test_merge_assistant_groups_sentences_per_turn():
    """回放给 LLM 前，同回合的多句 assistant 必须合并成一条。"""
    merged = turn._merge_assistant(
        [
            {"role": "user", "text": "问1", "at": "t"},
            {"role": "assistant", "text": "答1。", "at": "t"},
            {"role": "assistant", "text": "答2。", "at": "t"},
            {"role": "user", "text": "问2", "at": "t"},
            {"role": "assistant", "text": "答3。", "at": "t"},
        ]
    )
    assert merged == [
        {"role": "user", "content": "问1"},
        {"role": "assistant", "content": "答1。答2。"},
        {"role": "user", "content": "问2"},
        {"role": "assistant", "content": "答3。"},
    ]
