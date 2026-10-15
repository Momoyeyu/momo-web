"""拓展模块：工具名前缀/合法化、run_call 转发与失败文本化、不可用 server 不注入。

MCP 侧全部 mock（fake session/result），不起真实 server；hub.open 的
不可用路径用「必然失败的连接」走真实失败分支（不启动任何服务）。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app import agent, llm
from app.agent import mcp_ext
from app.agent.mcp_ext import ExtTools, hub, result_text, sanitize, tool_decl
from app.agent.tools import TOOLS, run_call


class _FakeTool:
    def __init__(self, name, description="", input_schema=None):
        self.name = name
        self.description = description
        self.title = None
        self.input_schema = input_schema or {"type": "object", "properties": {}}


def _text_result(*texts: str, is_error=False):
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=t) for t in texts],
        is_error=is_error,
        structured_content=None,
    )


def _source(prefix="tavily", tools=None, session=None):
    return mcp_ext._Source(
        prefix, session if session is not None else object(),
        tools if tools is not None else [_FakeTool("search")],
    )


_BUILTIN_NAMES = {d["function"]["name"] for d in TOOLS}


def _ext_with(src: mcp_ext._Source) -> ExtTools:
    ext = ExtTools()
    ext.add_source(src, set(_BUILTIN_NAMES))
    return ext


# ---- 名称合法化与前缀注入 ----

def test_sanitize_legalizes_names():
    assert sanitize("tavily") == "tavily"
    assert sanitize("my server-2.0") == "my_server_2_0"
    assert sanitize("搜索/工具") == "_____"
    assert sanitize("") == "ext"
    assert sanitize(None) == "ext"


def test_tool_decl_prefixes_and_passthrough_schema():
    tool = _FakeTool(
        "web-search",
        "搜索网页",
        {"type": "object", "properties": {"q": {"type": "string"}}},
    )
    decl = tool_decl("my_server", tool)
    fn = decl["function"]
    assert decl["type"] == "function"
    assert fn["name"] == "my_server_web_search"
    assert fn["description"] == "搜索网页"
    assert fn["parameters"]["properties"]["q"]["type"] == "string"


def test_add_source_skips_builtin_and_duplicate_names():
    # 与内置撞名丢弃（memory_add 是内置）；同前缀重复工具名也只留第一个
    src = _source(
        "memory",  # sanitize 后前缀 memory → memory_add 撞内置
        tools=[_FakeTool("add"), _FakeTool("x"), _FakeTool("x")],
    )
    ext = _ext_with(src)
    names = [d["function"]["name"] for d in ext.decls]
    assert names == ["memory_x"]
    assert "memory_add" in _BUILTIN_NAMES and "memory_add" not in names


# ---- tools/call 转发与失败语义 ----

def test_run_call_forwards_to_mcp_server(monkeypatch):
    seen = {}

    def fake_call_tool(session, name, args):
        seen["session"] = session
        seen["name"] = name
        seen["args"] = args
        return _text_result("结果A", "结果B")

    monkeypatch.setattr(hub, "call_tool", fake_call_tool)
    session = object()
    ext = _ext_with(_source(session=session))

    call = {
        "id": "c1",
        "type": "function",
        "function": {
            "name": "tavily_search",
            "arguments": json.dumps({"q": "天气"}),
        },
    }
    msg = run_call(call, pins=[], ext=ext)
    assert msg["role"] == "tool" and msg["tool_call_id"] == "c1"
    assert msg["content"] == "结果A\n结果B"
    assert seen["session"] is session
    assert seen["name"] == "search"  # 转发原始工具名（去前缀）
    assert seen["args"] == {"q": "天气"}


def test_run_call_mcp_failure_becomes_tool_text(monkeypatch):
    def boom(session, name, args):
        raise RuntimeError("connection reset")

    monkeypatch.setattr(hub, "call_tool", boom)
    ext = _ext_with(_source())
    msg = run_call(
        {"id": "c2", "function": {"name": "tavily_search", "arguments": "{}"}},
        pins=[],
        ext=ext,
    )
    assert "工具执行失败" in msg["content"]
    assert "connection reset" in msg["content"]


def test_run_call_ext_present_builtin_still_works(monkeypatch):
    monkeypatch.setattr(
        hub, "call_tool", lambda *a: pytest.fail("不该转发内置工具")
    )
    ext = _ext_with(_source())
    msg = run_call(
        {"id": "c3", "function": {"name": "common_time", "arguments": "{}"}},
        pins=[],
        ext=ext,
    )
    assert "iso" in json.loads(msg["content"])


def test_result_text_non_text_blocks_and_error():
    block = SimpleNamespace(type="image", model_dump_json=lambda: '{"type":"image"}')
    assert result_text(SimpleNamespace(content=[block], is_error=False)) == '{"type":"image"}'
    assert result_text(SimpleNamespace(content=[], is_error=True)) == "tool error"
    assert result_text(SimpleNamespace(content=[], is_error=False)) == "ok"
    sc = SimpleNamespace(content=[], is_error=False, structured_content={"a": 1})
    assert json.loads(result_text(sc)) == {"a": 1}


# ---- 不可用即不可见 ----

def test_open_skips_disabled_and_unconfigured():
    assert hub.open(None).decls == []
    assert hub.open([]).decls == []
    assert hub.open("junk").decls == []
    # 未启用 / 缺 endpoint / 缺 command：不尝试连接
    exts = [
        {"name": "a", "transport": "http", "endpoint": "http://x", "enabled": False},
        {"name": "b", "transport": "http", "endpoint": "", "enabled": True},
        {"name": "c", "transport": "stdio", "command": " ", "enabled": True},
    ]
    assert hub.open(exts).decls == []


def test_open_unreachable_server_yields_no_tools():
    # 不存在的 stdio 命令：连接必然失败 → 空工具表，不抛异常
    exts = [
        {
            "name": "bad server",
            "transport": "stdio",
            "command": "mcp-no-such-command-xyz",
            "enabled": True,
        }
    ]
    tools = hub.open(exts)
    assert tools.decls == []
    assert tools.call("bad_server_x", {}) == "未知工具：bad_server_x"
    hub.close()


# ---- run_turn 接线 ----

def _tool_call(name, args="{}"):
    return {
        "id": "call_1",
        "type": "function",
        "function": {"name": name, "arguments": args},
    }


def test_run_turn_extends_tools_and_dispatches(monkeypatch):
    ext = _ext_with(_source())
    monkeypatch.setattr(hub, "open", lambda exts: ext)
    closed = []
    monkeypatch.setattr(hub, "close", lambda: closed.append(1))
    monkeypatch.setattr(
        hub, "call_tool", lambda s, n, a: _text_result("mcp says hi")
    )

    seen_tools = []

    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
        seen_tools.append(tools)
        if len(seen_tools) == 1:
            return {
                "role": "assistant",
                "content": None,
                "tool_calls": [_tool_call("tavily_search", '{"q":"x"}')],
            }
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        assert tool_msgs[-1]["content"] == "mcp says hi"
        return {"role": "assistant", "content": "查到了。"}

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    events = list(agent.run_turn("帮我搜一下"))
    assert [e["text"] for e in events if e["t"] == "delta"] == ["查到了。"]
    # 注入声明 = 内置 + 拓展
    names = {d["function"]["name"] for d in seen_tools[0]}
    assert "tavily_search" in names and "memory_add" in names
    assert closed  # 回合结束连接已关闭


def test_run_turn_without_extensions_passes_static_tools(monkeypatch):
    monkeypatch.setattr(hub, "open", lambda exts: ExtTools())
    monkeypatch.setattr(hub, "close", lambda: None)

    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
        assert tools is TOOLS  # 无拓展 → 静态表原样下发
        return {"role": "assistant", "content": "好。"}

    monkeypatch.setattr(llm, "chat_completion", fake_chat)
    events = list(agent.run_turn("hi"))
    assert [e["text"] for e in events if e["t"] == "delta"] == ["好。"]
