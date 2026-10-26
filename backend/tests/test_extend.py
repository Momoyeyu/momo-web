"""MCP capabilities use the sole Cordis host, including real owned child cleanup."""

from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import threading
from types import SimpleNamespace

import pytest

from app.core import mcp
from app.core.mcp import ExtTools, McpHub, result_text, sanitize, tool_decl
from app.core.plugin_host import PluginHost
from app.services.capability import TOOLS, run_call

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "plugin-host/test/fixtures/mcp-server.mjs"
NODE = shutil.which("node")
BUILTIN = {item["function"]["name"] for item in TOOLS}


@pytest.fixture
def live_hub(monkeypatch):
    if not NODE:
        pytest.skip("Node runtime is required for the Cordis integration test")
    events = []
    host = PluginHost(
        "test-python-mcp", lambda name, data: events.append((name, data)), lambda: 1
    )
    host.start()
    runtime = SimpleNamespace(host=host, mode="meeting", virtual_enabled=False)
    runtime.configure_host_plugins = lambda configs, tolerate_errors=True, revision=None: host.request("plugins.configure", {"plugins": configs, "tolerateErrors": tolerate_errors, "configurationRevision": revision}, timeout=15)
    runtime.command = lambda method, params: host.request(
        method, {**params, "permit": host.permit("test-run")}, timeout=15
    )
    monkeypatch.setattr(mcp, "_runtime", lambda: runtime)
    facade = McpHub()
    monkeypatch.setattr(mcp, "hub", facade)
    yield facade, runtime, events
    facade.close()
    host.close()


def extension(name="echo", **extra):
    return {
        "name": name,
        "enabled": True,
        "transport": "stdio",
        "command": NODE,
        "args": [str(SERVER)],
        **extra,
    }


def test_names_schemas_and_collision_gate():
    assert sanitize("my server-2.0") == "my_server_2_0"
    assert sanitize(None) == "ext"
    schema = {"type": "object", "properties": {"q": {"type": "string"}}}
    assert tool_decl(
        "server", {"name": "web-search", "description": "search", "inputSchema": schema}
    )["function"] == {
        "name": "server_web_search",
        "description": "search",
        "parameters": schema,
    }
    long = tool_decl("x" * 70, {"name": "y" * 80})["function"]["name"]
    assert len(long) == 64 and re.fullmatch(r"[A-Za-z0-9_]+", long)
    tools = ExtTools()
    tools.add_source(
        mcp._Source(
            "memory", "plugin", [{"name": "add"}, {"name": "x"}, {"name": "x"}]
        ),
        set(BUILTIN),
    )
    assert [item["function"]["name"] for item in tools.decls] == ["memory_x"]


def test_result_projection_supports_sdk_json_and_legacy_objects():
    assert (
        result_text(
            {"content": [{"type": "text", "text": "a"}, {"type": "text", "text": "b"}]}
        )
        == "a\nb"
    )
    assert result_text({"content": [], "structuredContent": {"a": 1}}) == '{"a": 1}'
    assert result_text(SimpleNamespace(content=[], is_error=True)) == "tool error"
    assert (
        result_text({"content": [{"type": "image", "data": "abc"}]})
        == '{"type": "image", "data": "abc"}'
    )


def test_legacy_command_line_and_explicit_env_only(tmp_path, monkeypatch):
    monkeypatch.setenv("PRIVATE_PARENT_SECRET", "must-not-inherit")
    params = mcp._stdio_params(
        {"command": "npx -y server", "args": 'a "b c"', "env": {"EXPLICIT": "value"}}
    )
    assert (params.command, params.args) == ("npx", ["-y", "server", "a", "b c"])
    assert params.env == {"EXPLICIT": "value"}
    executable = tmp_path / "My Tools" / "node"
    executable.parent.mkdir()
    executable.write_text("#!/bin/sh\n")
    assert mcp._stdio_params({"command": str(executable)}).command == str(executable)


def test_http_headers_travel_only_in_private_host_config():
    config = mcp._translate(
        {
            "transport": "http",
            "endpoint": "https://example.invalid/mcp",
            "headers": {"Authorization": "Bearer private"},
        },
        "plugin",
    )
    assert config["transport"] == "streamable-http"
    assert config["headers"] == {"Authorization": "Bearer private"}
    assert config["url"] == "https://example.invalid/mcp"


def test_persistent_real_connection_survives_turn_scope_and_other_plugin_disable(
    live_hub,
):
    facade, runtime, _ = live_hub
    config = extension()
    with mcp.open_tools([config], BUILTIN) as tools:
        first = json.loads(tools.call("echo_echo", {"text": "first"}))
    with mcp.open_tools([config], BUILTIN) as tools:
        second = json.loads(tools.call("echo_echo", {"text": "second"}))
    assert second["pid"] == first["pid"]
    assert second["calls"] == 2
    facade.configure([config, extension("other")])
    facade.configure([config])
    third = json.loads(facade.open([config], BUILTIN).call("echo_echo", {}))
    assert third["pid"] == first["pid"] and third["calls"] == 3
    assert not hasattr(facade, "_loop") and not hasattr(facade, "_tasks")


def test_settings_disable_blocks_stale_tools_and_stale_turn_snapshot_cannot_reenable(
    live_hub,
):
    facade, _, events = live_hub
    config = extension()
    stale = facade.open([config], BUILTIN)
    facade.configure([{**config, "enabled": False}])
    assert "授权已失效" in stale.call("echo_echo", {})
    assert facade.open([config], BUILTIN).decls == []
    assert not any(name == "receipt" for name, _ in events)


@pytest.mark.parametrize(
    "change",
    [
        {"args": [str(SERVER), "--account=new"]},
        {"env": {"ACCOUNT_TOKEN": "test-new-account-token"}},
        {"headers": {"Authorization": "Bearer test-new-account-token"}},
        {"accountId": "another-bound-account"},
    ],
)
def test_config_changes_invalidate_existing_tool_catalog_even_with_same_plugin_id(
    live_hub, change
):
    facade, _, events = live_hub
    original = extension()
    stale = facade.open([original], BUILTIN)
    original_plugin_id = next(iter(facade._desired))
    assert facade.configure([extension(**change)]) is True
    assert next(iter(facade._desired)) == original_plugin_id
    assert "授权已失效" in stale.call("echo_echo", {})
    assert not any(name == "receipt" for name, _ in events)
    fresh = facade.open([original], BUILTIN)
    result = json.loads(fresh.call("echo_echo", {"text": "new binding"}))
    assert result["calls"] == 1 and result["text"] == "new binding"


def test_host_dispatch_rechecks_binding_if_config_changes_after_python_gate(
    live_hub, monkeypatch
):
    facade, runtime, events = live_hub
    stale = facade.open([extension()], BUILTIN)
    dispatch = runtime.command

    def switch_account_then_dispatch(method, params):
        assert facade.configure([extension(accountId="different-account")]) is True
        return dispatch(method, params)

    monkeypatch.setattr(runtime, "command", switch_account_then_dispatch)
    assert "授权已失效" in stale.call("echo_echo", {})
    assert not any(name == "receipt" for name, _ in events)


def test_reenabling_identical_config_cannot_revive_a_pre_revocation_catalog(live_hub):
    facade, _, _ = live_hub
    config = extension()
    stale = facade.open([config], BUILTIN)
    assert facade.configure([]) is True
    assert facade.configure([config]) is True
    assert "授权已失效" in stale.call("echo_echo", {})
    fresh = facade.open([config], BUILTIN)
    assert json.loads(fresh.call("echo_echo", {}))["calls"] == 1


def test_configuration_acknowledgement_is_explicit_and_failure_keeps_empty_gate(
    live_hub, monkeypatch
):
    facade, runtime, _ = live_hub
    stale = facade.open([extension()], BUILTIN)
    assert facade.configure([extension()]) is True
    with monkeypatch.context() as patch:
        patch.setattr(
            runtime.host,
            "request",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                RuntimeError("transport failed")
            ),
        )
        assert facade.configure([]) is False
        assert facade._configured_once is True and facade._desired == {}
        assert "授权已失效" in stale.call("echo_echo", {})
        assert facade.open([extension()], BUILTIN).decls == []


def test_disable_local_gate_changes_before_a_slow_host_configuration(
    live_hub, monkeypatch
):
    facade, runtime, _ = live_hub
    stale = facade.open([extension()], BUILTIN)
    entered, release = threading.Event(), threading.Event()
    original = runtime.host.request

    def slow(method, params=None, timeout=12):
        if method == "plugins.configure":
            entered.set()
            release.wait(2)
        return original(method, params, timeout)

    monkeypatch.setattr(runtime.host, "request", slow)
    worker = threading.Thread(target=lambda: facade.configure([]))
    worker.start()
    assert entered.wait(1)
    try:
        assert "授权已失效" in stale.call("echo_echo", {})
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive()


def test_reordered_old_reconcile_cannot_reenable_a_disabled_node_connection(
    live_hub, monkeypatch
):
    facade, runtime, _ = live_hub
    config = extension()
    facade.open([config], BUILTIN)
    entered, release = threading.Event(), threading.Event()
    original = runtime.host.request

    def reordered(method, params=None, timeout=12):
        if method == "plugins.configure" and params.get("configurationRevision") == 1:
            entered.set()
            release.wait(2)
        return original(method, params, timeout)

    monkeypatch.setattr(runtime.host, "request", reordered)
    worker = threading.Thread(target=lambda: facade.open([config], BUILTIN))
    worker.start()
    assert entered.wait(1)
    try:
        facade.configure([])
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive()
    assert runtime.host.request("plugins.listTools")["tools"] == []


def test_reviewed_activity_scope_is_available_when_active_and_blocked_during_focus(live_hub):
    facade, runtime, _ = live_hub
    game = extension(
        declaredPermissions=["mcp.tools", "activities.game"],
        grantedPermissions=["mcp.tools", "activities.game"],
    )
    tools = facade.open([game], BUILTIN)
    assert tools.has("echo_echo")
    runtime.focus = True
    assert facade.open([game], BUILTIN).decls == []
    assert "授权已失效" in tools.call("echo_echo", {})
    runtime.focus = False
    assert facade.open([game], BUILTIN).has("echo_echo")
    runtime.mode = "dormant"
    assert facade.open([game], BUILTIN).decls == []


def test_ungranted_unknown_and_malformed_permissions_fail_closed(live_hub):
    facade, _, _ = live_hub
    for extra in (
        {"declaredPermissions": ["activities.game"]},
        {"declaredPermissions": ["unknown"]},
        {"declaredPermissions": [{}]},
        {"grantedPermissions": "all"},
    ):
        facade.configure([extension(**extra)])
        assert facade.open([extension()], BUILTIN).decls == []


def test_one_broken_plugin_does_not_hide_a_healthy_plugin(live_hub):
    facade, _, _ = live_hub
    tools = facade.open(
        [extension("broken", command="mcp-no-such-command-xyz"), extension()], BUILTIN
    )
    assert tools.has("echo_echo")
    assert not tools.has("broken_echo")


def test_separate_probe_preserves_active_host_and_connection(live_hub):
    facade, runtime, _ = live_hub
    active = facade.open([extension()], BUILTIN)
    first = json.loads(active.call("echo_echo", {}))
    original_host_pid = runtime.host.process.pid
    assert facade.probe(extension("probe")) == {"ok": True, "tools": 2}
    second = json.loads(active.call("echo_echo", {}))
    assert runtime.host.process.pid == original_host_pid
    assert second["pid"] == first["pid"] and second["calls"] == 2


def test_probe_errors_and_tool_errors_never_expose_credentials(live_hub, monkeypatch):
    facade, runtime, _ = live_hub
    assert facade.probe({"name": "x", "transport": "http"}) == {
        "ok": False,
        "tools": 0,
        "error": "unconfigured",
    }
    assert facade.probe(
        extension(command="/no/such/command", env={"SECRET": "private-key"})
    ) == {"ok": False, "tools": 0, "error": "unavailable"}
    tools = facade.open([extension()], BUILTIN)

    def error(*_):
        raise RuntimeError("Authorization: private-key")

    monkeypatch.setattr(runtime, "command", error)
    assert "private-key" not in tools.call("echo_echo", {})


def test_builtin_dispatch_remains_separate(live_hub):
    facade, _, _ = live_hub
    tools = facade.open([extension()], BUILTIN)
    message = run_call(
        {"id": "c", "function": {"name": "common_time", "arguments": "{}"}}, ext=tools
    )
    assert "utc" in json.loads(message["content"])


def test_probe_http_api_keeps_public_shape(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(mcp.hub, "probe", lambda ext: {"ok": True, "tools": 2})
    response = TestClient(app).post("/api/extensions/probe", json=extension())
    assert response.status_code == 200 and response.json() == {"ok": True, "tools": 2}
