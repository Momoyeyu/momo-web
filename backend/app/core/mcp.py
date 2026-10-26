"""MCP façade: Cordis owns connections; Python owns permissions and execution order.

There is no Python MCP event loop or transport in the active path. A turn gets a
catalog projection; leaving the turn never closes another turn's connection.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
from pathlib import Path
import re
import shlex
import secrets
import threading
from types import SimpleNamespace
from typing import Any, Iterator

from .plugin_host import PluginHost

CONNECT_TIMEOUT = 8.0
OPEN_TIMEOUT = 12.0
CALL_TIMEOUT = 30.0
_NAME_RE = re.compile(r"[^a-zA-Z0-9_]")
_SCOPES = frozenset(
    {"mcp.tools", "channels.send", "activities.game", "activities.computer"}
)
_coordinator = SimpleNamespace(host=None, mode="paused", virtual_enabled=False)


def _runtime():
    return _coordinator


def sanitize(name: Any) -> str:
    return _NAME_RE.sub("_", str(name or "")) or "ext"


def _field(value, name, default=None):
    return (
        value.get(name, default)
        if isinstance(value, dict)
        else getattr(value, name, default)
    )


def tool_decl(server_key: str, tool: Any) -> dict[str, Any]:
    original = str(_field(tool, "name", ""))
    name = f"{sanitize(server_key)}_{sanitize(original)}"
    if len(name) > 64:
        name = name[:51] + "_" + hashlib.sha256(name.encode()).hexdigest()[:12]
    schema = _field(tool, "inputSchema", _field(tool, "input_schema"))
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": str(
                _field(tool, "description") or _field(tool, "title") or ""
            ),
            "parameters": schema
            if isinstance(schema, dict)
            else {"type": "object", "properties": {}},
        },
    }


def result_text(result: Any) -> str:
    parts = []
    for block in _field(result, "content", []) or []:
        if _field(block, "type") == "text" and _field(block, "text") is not None:
            parts.append(str(_field(block, "text")))
        elif isinstance(block, dict):
            parts.append(json.dumps(block, ensure_ascii=False))
        else:
            try:
                parts.append(block.model_dump_json())
            except Exception:
                parts.append(str(block))
    if parts:
        return "\n".join(parts)
    structured = _field(
        result, "structuredContent", _field(result, "structured_content")
    )
    if structured is not None:
        return json.dumps(structured, ensure_ascii=False)
    return (
        "tool error"
        if _field(result, "isError", _field(result, "is_error", False))
        else "ok"
    )


class _Source:
    def __init__(self, prefix, session, tools, fingerprint=None):
        self.prefix, self.session, self.tools = prefix, session, tools
        self.fingerprint = fingerprint


class ExtTools:
    def __init__(self):
        self.decls = []
        self._routes = {}

    def add_source(self, src, taken):
        for tool in src.tools:
            decl = tool_decl(src.prefix, tool)
            name = decl["function"]["name"]
            if name in taken:
                continue
            taken.add(name)
            self._routes[name] = (
                src.session,
                str(_field(tool, "name", "")),
                src.fingerprint,
            )
            self.decls.append(decl)

    def has(self, name):
        return name in self._routes

    def call(self, name, args):
        route = self._routes.get(name)
        if route is None:
            return f"未知工具：{name}"
        try:
            plugin_id, original_name, fingerprint = route
            return result_text(
                hub.call_tool(plugin_id, original_name, args, fingerprint=fingerprint)
            )
        except Exception:
            # Provider errors can contain headers, URLs, keys or private content.
            return "工具执行失败：当前工具不可用或授权已失效。"


def _configured(ext):
    return bool(
        str(
            ext.get("command" if ext.get("transport") == "stdio" else "endpoint") or ""
        ).strip()
    )


def _str_dict(raw):
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in raw.items() if isinstance(value, str)}


def _stdio_params(ext):
    """Compatibility parsing only; no Python transport, no parent environment copy."""
    command = str(ext.get("command") or "").strip()
    raw = ext.get("args", [])
    args = (
        shlex.split(raw)
        if isinstance(raw, str)
        else [str(arg) for arg in raw]
        if isinstance(raw, list)
        else []
    )
    parts = [command] if Path(command).is_file() else shlex.split(command)
    if not parts:
        raise ValueError("Unconfigured MCP command")
    return SimpleNamespace(
        command=parts[0], args=parts[1:] + args, env=_str_dict(ext.get("env"))
    )


def _permissions(ext):
    # Existing explicit enabled=true grants a user-trusted general MCP server.
    # Reviewed channel/game/computer adapters must declare their actual scopes.
    declared = ext.get("declaredPermissions", ["mcp.tools"])
    granted = ext.get("grantedPermissions", ["mcp.tools"])
    if not isinstance(declared, list) or not isinstance(granted, list):
        return set(), set()
    if any(not isinstance(scope, str) for scope in declared + granted):
        return set(), set()
    if not set(declared) <= _SCOPES or not set(granted) <= _SCOPES:
        return set(), set()
    return set(declared), set(granted)


def _translate(ext, plugin_id):
    config = {
        "id": plugin_id,
        "type": "mcp",
        "enabled": True,
        "timeoutMs": int(CALL_TIMEOUT * 1000),
        "connectTimeoutMs": int(CONNECT_TIMEOUT * 1000),
    }
    if ext.get("transport") == "stdio":
        params = _stdio_params(ext)
        config.update(
            transport="stdio", command=params.command, args=params.args, env=params.env
        )
        if ext.get("cwd"):
            config["cwd"] = str(ext["cwd"])
    else:
        config.update(
            transport="sse" if ext.get("transport") == "sse" else "streamable-http",
            url=str(ext.get("endpoint") or ""),
            headers=_str_dict(ext.get("headers")),
        )
    return config


def _entries(extensions):
    entries, duplicates = {}, {}
    for ext in extensions if isinstance(extensions, list) else []:
        if (
            not isinstance(ext, dict)
            or ext.get("enabled") is not True
            or not _configured(ext)
        ):
            continue
        identity = json.dumps(
            {
                key: ext.get(key)
                for key in ("id", "name", "transport", "command", "endpoint")
            },
            sort_keys=True,
            ensure_ascii=False,
        )
        suffix = hashlib.sha256(identity.encode()).hexdigest()[:12]
        ordinal = duplicates.get(suffix, 0)
        duplicates[suffix] = ordinal + 1
        plugin_id = f"mcp_{sanitize(ext.get('name'))[:20]}_{suffix}_{ordinal}"
        declared, granted = _permissions(ext)
        if not declared or not declared <= granted:
            continue
        try:
            # Account / credential / argument changes do not always change the
            # stable plugin id. Bind each projected route to this exact config.
            fingerprint = hashlib.sha256(
                json.dumps(ext, sort_keys=True, ensure_ascii=False).encode()
            ).hexdigest()
            config = {**_translate(ext, plugin_id), "bindingFingerprint": fingerprint}
            entries[plugin_id] = {
                "config": config,
                "rawFingerprint": fingerprint,
                "fingerprint": fingerprint,
                "prefix": sanitize(ext.get("name")),
                "declared": declared,
                "granted": granted,
            }
        except (ValueError, TypeError):
            continue
    return entries


class McpHub:
    """Catalog/permission bridge to the coordinator's sole Cordis child."""

    def __init__(self):
        self._lock = threading.RLock()
        self._reconcile_lock = threading.Lock()
        self._desired = {}
        self._configured_once = False
        self._revision = 0
        self._host_id = None
        self.current = ExtTools()

    def bind(self, coordinator):
        """Service-layer composition supplies the sole coordinator dependency."""
        global _coordinator
        _coordinator = coordinator

    def _allowed(self, entry):
        runtime = _runtime()
        scopes = _SCOPES if runtime.mode == "meeting" and not getattr(runtime, "focus", False) else set()
        return (
            bool(entry["declared"]) and entry["declared"] <= entry["granted"] & scopes
        )

    def _activate(self, extensions):
        entries = _entries(extensions)
        for plugin_id, entry in entries.items():
            previous = self._desired.get(plugin_id)
            if previous and previous["rawFingerprint"] == entry["rawFingerprint"]:
                fingerprint = previous["fingerprint"]
            else:
                # Re-enabling even an identical config is a new authorization,
                # not permission to resume a catalog from before revocation.
                fingerprint = hashlib.sha256(
                    (entry["rawFingerprint"] + secrets.token_hex(16)).encode()
                ).hexdigest()
            entry["fingerprint"] = fingerprint
            entry["config"]["bindingFingerprint"] = fingerprint
        return entries

    def configure(self, extensions):
        # Publish the new gate before any network I/O. Existing ExtTools objects
        # therefore cannot execute a disabled/reclassified plugin.
        with self._lock:
            self._desired = self._activate(extensions)
            self._revision += 1
            revision = self._revision
            self._configured_once = True
            host = _runtime().host
            self._host_id = host
            configs = self._configs_locked()
        if host:
            # Dispatch immediately: Node withdraws disabled gates before waiting
            # for its serialized connection lifecycle queue.
            try:
                _runtime().configure_host_plugins(configs, tolerate_errors=True, revision=revision)
                return True
            except Exception:
                return False
        return False

    def _configs_locked(self):
        configs = [item["config"] for item in self._desired.values()]
        if getattr(_runtime(), "virtual_enabled", False):
            configs.append({"id": "virtual", "type": "virtual", "enabled": True})
        return configs

    def _reconcile(self):
        host = _runtime().host
        if not host:
            return []
        with self._reconcile_lock:
            with self._lock:
                configs, revision = self._configs_locked(), self._revision
            try:
                _runtime().configure_host_plugins(configs, tolerate_errors=True, revision=revision)
                return host.request("plugins.listTools").get("tools", [])
            except Exception:
                return []

    def open(self, extensions, reserved):
        host = _runtime().host
        if not host:
            return ExtTools()
        with self._lock:
            if not self._configured_once:
                self._desired = self._activate(extensions)
                self._configured_once = True
                self._revision += 1
            self._host_id = host
        catalog = self._reconcile()
        tools, taken = ExtTools(), set(reserved)
        with self._lock:
            for plugin_id, entry in self._desired.items():
                if not self._allowed(entry):
                    continue
                listed = [
                    dict(tool, name=tool["originalName"])
                    for tool in catalog
                    if tool.get("pluginId") == plugin_id
                    and tool.get("configurationFingerprint") == entry["fingerprint"]
                ]
                tools.add_source(
                    _Source(entry["prefix"], plugin_id, listed, entry["fingerprint"]),
                    taken,
                )
            self.current = tools
        return tools

    def call_tool(self, plugin_id, original_name, args, *, fingerprint=None):
        with self._lock:
            entry = self._desired.get(plugin_id)
            if (
                not entry
                or not self._allowed(entry)
                or entry["fingerprint"] != fingerprint
            ):
                raise PermissionError("MCP capability or configuration is stale")
        result = _runtime().command(
            "plugins.callTool",
            {
                "name": f"{plugin_id}__{original_name}",
                "arguments": args,
                "configurationFingerprint": fingerprint,
            },
        )
        return result["result"]

    def probe(self, ext):
        if not isinstance(ext, dict) or not _configured(ext):
            return {"ok": False, "tools": 0, "error": "unconfigured"}
        host = PluginHost(
            "probe-" + __import__("uuid").uuid4().hex, lambda *_: None, lambda: 0
        )
        try:
            host.start()
            config = _translate(ext, "probe")
            host.request(
                "plugins.configure", {"plugins": [config]}, timeout=CONNECT_TIMEOUT + 3
            )
            tools = host.request("plugins.listTools").get("tools", [])
            return {"ok": True, "tools": len(tools)}
        except Exception:
            return {"ok": False, "tools": 0, "error": "unavailable"}
        finally:
            host.close()

    def close(self):
        # Application shutdown owns the host process. This method only retires
        # the façade; turn scope never invokes it.
        with self._lock:
            self.current = ExtTools()
            self._desired = {}
            self._configured_once = False
            self._host_id = None


@contextlib.contextmanager
def open_tools(extensions: Any, reserved: set[str]) -> Iterator[ExtTools]:
    yield hub.open(extensions, reserved)


hub = McpHub()
