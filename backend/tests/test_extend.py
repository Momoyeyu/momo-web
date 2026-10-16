"""拓展模块：工具名前缀/合法化、run_call 转发与失败文本化、不可用 server 不注入。

MCP 侧全部 mock（fake session/result），不起真实 server；hub.open 的
不可用路径用「必然失败的连接」走真实失败分支（不启动任何服务）。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.core import llm
from app.services import turn
from app.core import mcp as extend
from app.core.mcp import ExtTools, hub, result_text, sanitize, tool_decl
from app.services.capability import TOOLS, run_call


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
    return extend._Source(
        prefix, session if session is not None else object(),
        tools if tools is not None else [_FakeTool("search")],
    )


_BUILTIN_NAMES = {d["function"]["name"] for d in TOOLS}


def _ext_with(src: extend._Source) -> ExtTools:
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
    msg = run_call(call, ext=ext)
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
        ext=ext,
    )
    assert "utc" in json.loads(msg["content"])


def test_result_text_non_text_blocks_and_error():
    block = SimpleNamespace(type="image", model_dump_json=lambda: '{"type":"image"}')
    assert result_text(SimpleNamespace(content=[block], is_error=False)) == '{"type":"image"}'
    assert result_text(SimpleNamespace(content=[], is_error=True)) == "tool error"
    assert result_text(SimpleNamespace(content=[], is_error=False)) == "ok"
    sc = SimpleNamespace(content=[], is_error=False, structured_content={"a": 1})
    assert json.loads(result_text(sc)) == {"a": 1}


# ---- 不可用即不可见 ----

def test_open_skips_disabled_and_unconfigured():
    assert hub.open(None, _BUILTIN_NAMES).decls == []
    assert hub.open([], _BUILTIN_NAMES).decls == []
    assert hub.open("junk", _BUILTIN_NAMES).decls == []
    # 未启用 / 缺 endpoint / 缺 command：不尝试连接
    exts = [
        {"name": "a", "transport": "http", "endpoint": "http://x", "enabled": False},
        {"name": "b", "transport": "http", "endpoint": "", "enabled": True},
        {"name": "c", "transport": "stdio", "command": " ", "enabled": True},
    ]
    assert hub.open(exts, _BUILTIN_NAMES).decls == []


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
    tools = hub.open(exts, _BUILTIN_NAMES)
    assert tools.decls == []
    assert tools.call("bad_server_x", {}) == "未知工具：bad_server_x"
    hub.close()


# ---- 连接参数：stdio env 注入 / http headers 透传 ----


class _FakeACM:
    """enter_async_context 兼容的假 async context manager。"""

    def __init__(self, value):
        self._v = value

    async def __aenter__(self):
        return self._v

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    """ClientSession 替身：initialize/list_tools 返回固定工具。"""

    def __init__(self, read, write):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def initialize(self):
        pass

    async def list_tools(self):
        return SimpleNamespace(tools=[_FakeTool("ping")])


def test_stdio_connect_passes_args_and_merged_env(monkeypatch):
    seen = {}

    def fake_stdio_client(params):
        seen["params"] = params
        return _FakeACM((object(), object()))

    monkeypatch.setattr(extend, "stdio_client", fake_stdio_client)
    monkeypatch.setattr(extend, "ClientSession", _FakeSession)
    monkeypatch.setenv("MOMO_TEST_HOSTENV", "host")

    tools = hub.open(
        [
            {
                "name": "loc",
                "transport": "stdio",
                "command": "uvx",
                "args": ["mcp-fs"],
                "env": {"MY_KEY": "k1", "MOMO_TEST_HOSTENV": "override"},
                "enabled": True,
            }
        ]
    , _BUILTIN_NAMES)
    try:
        assert [d["function"]["name"] for d in tools.decls] == ["loc_ping"]
        p = seen["params"]
        assert p.command == "uvx"
        assert p.args == ["mcp-fs"]
        # env = os.environ 合并 ext.env，后者覆盖同名宿主变量
        assert p.env["MY_KEY"] == "k1"
        assert p.env["MOMO_TEST_HOSTENV"] == "override"
        assert "PATH" in p.env or "HOME" in p.env  # os.environ 透传
    finally:
        hub.close()


def test_stdio_params_split_legacy_command_line():
    # 旧式整行命令：首 token 作可执行名，其余前置于 args
    p = extend._stdio_params({"command": "npx -y tavily-mcp", "args": ["x"]})
    assert p.command == "npx"
    assert p.args == ["-y", "tavily-mcp", "x"]
    # args 容忍字符串形态（按 shell 规则拆）
    p = extend._stdio_params({"command": "uvx", "args": "-y mcp-fs"})
    assert p.args == ["-y", "mcp-fs"]


def test_http_connect_passes_all_headers(monkeypatch):
    seen = {}

    def fake_http_client(headers=None, **kw):
        seen["headers"] = headers
        return _FakeACM(object())

    def fake_streamable(url, http_client=None, **kw):
        seen["url"] = url
        return _FakeACM((object(), object()))

    monkeypatch.setattr(extend, "create_mcp_http_client", fake_http_client)
    monkeypatch.setattr(extend, "streamable_http_client", fake_streamable)
    monkeypatch.setattr(extend, "ClientSession", _FakeSession)

    ext = {
        "name": "remote",
        "transport": "http",
        "endpoint": "https://mcp.example.com/mcp",
        "headers": {"Authorization": "Bearer sek", "X-Team": "a"},
        "enabled": True,
    }
    tools = hub.open([ext], _BUILTIN_NAMES)
    try:
        assert [d["function"]["name"] for d in tools.decls] == ["remote_ping"]
        assert seen["url"] == "https://mcp.example.com/mcp"
        # headers 全量透传（鉴权走 Authorization 或自定义头）
        assert seen["headers"] == {"Authorization": "Bearer sek", "X-Team": "a"}
    finally:
        hub.close()


def test_http_connect_no_headers_passes_none(monkeypatch):
    seen = {}

    def fake_http_client(headers=None, **kw):
        seen["headers"] = headers
        return _FakeACM(object())

    monkeypatch.setattr(extend, "create_mcp_http_client", fake_http_client)
    monkeypatch.setattr(
        extend,
        "streamable_http_client",
        lambda url, http_client=None, **kw: _FakeACM((object(), object())),
    )
    monkeypatch.setattr(extend, "ClientSession", _FakeSession)

    tools = hub.open(
        [
            {
                "name": "r",
                "transport": "http",
                "endpoint": "https://x/mcp",
                "enabled": True,
            }
        ]
    , _BUILTIN_NAMES)
    try:
        assert tools.decls
        assert seen["headers"] is None
    finally:
        hub.close()


# ---- POST /api/extensions/probe ----


def _client():
    from fastapi.testclient import TestClient
    from app.main import app

    return TestClient(app)


def test_probe_endpoint_ok(monkeypatch):
    async def fake_connect(stack, ext):
        return extend._Source(
            "tavily", object(), [_FakeTool("a"), _FakeTool("b")]
        )

    monkeypatch.setattr(hub, "_connect", fake_connect)
    r = _client().post(
        "/api/extensions/probe",
        json={
            "name": "tavily",
            "transport": "stdio",
            "command": "npx",
            "enabled": True,
        },
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "tools": 2}


def test_probe_endpoint_connect_failure(monkeypatch):
    async def boom(stack, ext):
        raise RuntimeError("spawn failed")

    monkeypatch.setattr(hub, "_connect", boom)
    r = _client().post(
        "/api/extensions/probe",
        json={
            "name": "x",
            "transport": "stdio",
            "command": "npx",
            "enabled": True,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and body["tools"] == 0
    assert "spawn failed" in body["error"]


def test_probe_endpoint_unconfigured_skips_connect(monkeypatch):
    monkeypatch.setattr(
        hub, "_connect", lambda *a: pytest.fail("未配置不应连接")
    )
    r = _client().post(
        "/api/extensions/probe",
        json={"name": "x", "transport": "http", "enabled": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False and body["error"] == "unconfigured"


# ---- run_turn 接线 ----

def _tool_call(name, args="{}"):
    return {
        "id": "call_1",
        "type": "function",
        "function": {"name": name, "arguments": args},
    }


def test_run_turn_extends_tools_and_dispatches(monkeypatch):
    ext = _ext_with(_source())
    monkeypatch.setattr(hub, "open", lambda exts, reserved: ext)
    closed = []
    monkeypatch.setattr(hub, "close", lambda: closed.append(1))
    monkeypatch.setattr(
        hub, "call_tool", lambda s, n, a: _text_result("mcp says hi")
    )

    seen_tools = []

    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
        seen_tools.append(tools)
        if len(seen_tools) == 1:
            yield {
                "type": "tool_calls",
                "calls": [_tool_call("tavily_search", '{"q":"x"}')],
            }
            return
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        assert tool_msgs[-1]["content"] == "mcp says hi"
        yield {"type": "text", "delta": "查到了。"}

    monkeypatch.setattr(llm, "chat_stream", fake_chat)
    events = list(turn.run_turn("帮我搜一下"))
    assert [e["text"] for e in events if e["t"] == "sentence"] == ["查到了。"]
    # 注入声明 = 内置 + 拓展
    names = {d["function"]["name"] for d in seen_tools[0]}
    assert "tavily_search" in names and "memory_add" in names
    assert closed  # 回合结束连接已关闭


def test_run_turn_without_extensions_passes_static_tools(monkeypatch):
    monkeypatch.setattr(hub, "open", lambda exts, reserved: ExtTools())
    monkeypatch.setattr(hub, "close", lambda: None)

    def fake_chat(llm_cfg, messages, tools=None, usage_out=None):
        assert tools is TOOLS  # 无拓展 → 静态表原样下发
        yield {"type": "text", "delta": "好。"}

    monkeypatch.setattr(llm, "chat_stream", fake_chat)
    events = list(turn.run_turn("hi"))
    assert [e["text"] for e in events if e["t"] == "sentence"] == ["好。"]
