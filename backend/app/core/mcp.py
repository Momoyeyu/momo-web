"""拓展模块：把已启用 MCP server 的工具导入 ReAct 循环（modules/extend.md）。

- 设置页登记 {name, transport(stdio|http), enabled} + stdio 分支
  {command, args[], env{}} + http 分支 {endpoint, headers{}}
- 回合开始并发连接 enabled server → tools/list → 工具以 {server}_{tool}
  前缀名注入；server 连不上即不注入（不可用即不可见，不报错给用户）
- tools/call 转发回对应 server；失败把错误文本作为 tool result 回模型
- 每回合重建连接（连接状态变化下一回合生效），turn 结束关闭

MCP SDK 是 async 的，而 run_turn 是同步生成器——hub 开专属 daemon 线程
跑常驻 asyncio loop，同步侧经 run_coroutine_threadsafe 调用。每个 server
的连接/会话由同一个 task 全程持有（anyio cancel scope 要求进/出同一
task），close 通过 asyncio.Event 通知各 task 自行退出清理。
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shlex
import threading
from typing import TYPE_CHECKING, Any, Iterator

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import (
    create_mcp_http_client,
    streamable_http_client,
)

if TYPE_CHECKING:
    from ..models import ProbeResult


log = logging.getLogger(__name__)

CONNECT_TIMEOUT = 8.0  # 单个 server：连接 + initialize + tools/list
OPEN_TIMEOUT = 10.0    # 全部 server 就绪的总等待上限（不拖回合）
CALL_TIMEOUT = 30.0    # 单次 tools/call
CLOSE_TIMEOUT = 5.0

_NAME_RE = re.compile(r"[^a-zA-Z0-9_]")


def sanitize(name: Any) -> str:
    """server/工具名合法化：只留 [a-zA-Z0-9_]，其余转 _；空名兜底。"""
    s = _NAME_RE.sub("_", str(name or ""))
    return s or "ext"


def tool_decl(server_key: str, tool: Any) -> dict[str, Any]:
    """MCP Tool → OpenAI function 声明（inputSchema 原样透传）。"""
    desc = getattr(tool, "description", None) or getattr(tool, "title", None) or ""
    schema = getattr(tool, "input_schema", None)
    if not isinstance(schema, dict):
        schema = {"type": "object", "properties": {}}
    return {
        "type": "function",
        "function": {
            "name": f"{server_key}_{sanitize(getattr(tool, 'name', ''))}",
            "description": str(desc),
            "parameters": schema,
        },
    }


def result_text(result: Any) -> str:
    """CallToolResult → 纯文本：text 块拼接，非文本块序列化。"""
    parts: list[str] = []
    for c in getattr(result, "content", None) or []:
        if getattr(c, "type", None) == "text" and getattr(c, "text", None) is not None:
            parts.append(str(c.text))
        else:
            try:
                parts.append(c.model_dump_json())
            except Exception:
                parts.append(str(c))
    if parts:
        return "\n".join(parts)
    sc = getattr(result, "structured_content", None)
    if sc is not None:
        try:
            return json.dumps(sc, ensure_ascii=False)
        except Exception:
            return str(sc)
    return "tool error" if getattr(result, "is_error", False) else "ok"


class _Source:
    """一个已连接 server：合法化前缀 + session + 原始工具清单。"""

    __slots__ = ("prefix", "session", "tools")

    def __init__(self, prefix: str, session: ClientSession, tools: list[Any]):
        self.prefix = prefix
        self.session = session
        self.tools = tools


class ExtTools:
    """一回合内有效的拓展工具集合：decls 注入 tools 参数，call() 转发。"""

    def __init__(self) -> None:
        self.decls: list[dict[str, Any]] = []
        self._routes: dict[str, tuple[_Source, str]] = {}

    def add_source(self, src: _Source, taken: set[str]) -> None:
        """导入一个 server 的工具；与已有名（内置/其他 server）撞名则丢弃。"""
        for tool in src.tools:
            decl = tool_decl(src.prefix, tool)
            name = decl["function"]["name"]
            if name in taken:
                log.warning("mcp tool name clash dropped: %s", name)
                continue
            taken.add(name)
            self._routes[name] = (src, str(tool.name))
            self.decls.append(decl)

    def has(self, name: str) -> bool:
        return name in self._routes

    def call(self, name: str, args: dict[str, Any]) -> str:
        """转发 tools/call 到归属 server；失败文本化（不向上抛）。"""
        route = self._routes.get(name)
        if route is None:
            return f"未知工具：{name}"
        src, orig = route
        try:
            result = hub.call_tool(src.session, orig, args)
            return result_text(result)
        except Exception as e:
            return f"工具执行失败：{e}"


def _configured(ext: dict[str, Any]) -> bool:
    """配置完整性：stdio 要 command，http 要 endpoint；缺了视为不可用。"""
    if str(ext.get("transport") or "http") == "stdio":
        return bool(str(ext.get("command") or "").strip())
    return bool(str(ext.get("endpoint") or "").strip())


def _str_dict(raw: Any) -> dict[str, str]:
    """键值对字段归一化：只收 str 键值，其余丢弃。"""
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if isinstance(v, str)}


def _stdio_params(ext: dict[str, Any]) -> StdioServerParameters:
    """stdio 分支 → StdioServerParameters。

    command 是可执行名（如 npx/uvx）；args 是参数数组（容忍旧式字符串，
    按 shell 规则拆分）；env 键值对叠加在 os.environ 上注入子进程——
    密钥类凭据（如 TAVILY_API_KEY）经此传递。
    """
    command = str(ext.get("command") or "").strip()
    if not command:
        raise ValueError("empty command")
    raw_args = ext.get("args")
    if isinstance(raw_args, str):
        args = shlex.split(raw_args)
    elif isinstance(raw_args, list):
        args = [str(a) for a in raw_args]
    else:
        args = []
    # command 应为可执行名；旧数据可能是整行命令——shlex 拆出首 token
    # 作命令、其余前置于 args。
    parts = shlex.split(command)
    if len(parts) > 1:
        command, args = parts[0], parts[1:] + args
    env = {**os.environ, **_str_dict(ext.get("env"))}
    return StdioServerParameters(command=command, args=args, env=env)


class McpHub:
    """专属线程 + 常驻 asyncio loop 的 MCP 连接枢纽（惰性启动的单例）。"""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        # 以下仅由 loop 线程内的协程读写
        self._closers: set[asyncio.Event] = set()  # 每个存活 serve task 的退出事件
        self._tasks: list[asyncio.Task[None]] = []
        self.current = ExtTools()

    # ---- 同步侧（run_turn 调用） ----

    def open(self, extensions: Any, reserved: set[str]) -> ExtTools:
        """连接 enabled 且配置完整的 server；任何失败都收敛为空集合。

        extensions 来自 momo.yaml（用户可编辑、可能被写坏），故这里按 Any 收、
        运行时逐层校验，不信任类型。
        reserved：需要避让的工具名（内置能力名）——由 service 层传入，
        client 层不反向依赖 service。
        """
        enabled = [
            e
            for e in (extensions if isinstance(extensions, list) else [])
            if isinstance(e, dict)
            and e.get("enabled") is not False
            and _configured(e)
        ]
        if not enabled:
            return ExtTools()
        try:
            self._ensure_loop()
            self.close()  # 防御：上个 turn 没走到 close 时先清残留
            fut = asyncio.run_coroutine_threadsafe(
                self._open_async(enabled, reserved), self._loop
            )
            tools = fut.result(timeout=OPEN_TIMEOUT + 2)
            return tools if isinstance(tools, ExtTools) else ExtTools()
        except Exception:
            log.exception("mcp open failed")
            return ExtTools()

    def close(self) -> None:
        """通知各 server task 退出（连接/子进程随之清理）。"""
        loop = self._loop
        if loop is None or not self._tasks:
            return
        try:
            fut = asyncio.run_coroutine_threadsafe(self._close_async(), loop)
            fut.result(timeout=CLOSE_TIMEOUT + 3)
        except Exception:
            log.exception("mcp close failed")

    def call_tool(
        self, session: ClientSession, name: str, args: dict[str, Any]
    ) -> Any:
        """同步侧发起 tools/call（在常驻 loop 上跑 session 协程）。"""
        self._ensure_loop()
        fut = asyncio.run_coroutine_threadsafe(
            session.call_tool(name, args), self._loop
        )
        return fut.result(timeout=CALL_TIMEOUT)

    def probe(self, ext: dict[str, Any]) -> ProbeResult:
        """单条拓展的连通性探测（设置页状态点）：connect + list_tools + close。

        返回形状见 models.ProbeResult；任何失败都文本化，不向上抛。
        配置不完整直接判失败，不尝试连接。
        """
        if not isinstance(ext, dict) or not _configured(ext):
            return {"ok": False, "tools": 0, "error": "unconfigured"}
        try:
            self._ensure_loop()
            fut = asyncio.run_coroutine_threadsafe(
                self._probe_async(ext), self._loop
            )
            r = fut.result(timeout=CONNECT_TIMEOUT + 2)
            return r if isinstance(r, dict) else {"ok": False, "tools": 0}
        except Exception as e:
            return {"ok": False, "tools": 0, "error": str(e) or type(e).__name__}

    # ---- loop 线程内 ----

    def _ensure_loop(self) -> None:
        with self._lock:
            if self._loop is not None:
                return
            loop = asyncio.new_event_loop()
            threading.Thread(
                target=loop.run_forever, daemon=True, name="mcp-loop"
            ).start()
            self._loop = loop

    async def _open_async(
        self, enabled: list[dict[str, Any]], reserved: set[str]
    ) -> ExtTools:
        # 防御：残留的旧 serve task 先放行退出（并发回合/上轮未走到 close）
        for ev in self._closers:
            ev.set()
        self._tasks = [t for t in self._tasks if not t.done()]
        futs: list[asyncio.Future[_Source | None]] = []
        for ext in enabled:
            f: asyncio.Future[_Source | None] = self._loop.create_future()
            futs.append(f)
            self._tasks.append(asyncio.create_task(self._serve(ext, f)))
        try:
            sources = await asyncio.wait_for(
                asyncio.gather(*futs, return_exceptions=True),
                timeout=OPEN_TIMEOUT,
            )
        except Exception:
            sources = []
        tools = ExtTools()
        taken = set(reserved)
        for src in sources:
            if isinstance(src, _Source):
                tools.add_source(src, taken)
        self.current = tools
        return tools

    async def _serve(
        self, ext: dict[str, Any], ready: asyncio.Future[_Source | None]
    ) -> None:
        """单 server 生命周期：进/出 AsyncExitStack 必须在同一 task。"""
        done = asyncio.Event()
        self._closers.add(done)
        try:
            async with contextlib.AsyncExitStack() as stack:
                src = await self._connect(stack, ext)
                if not ready.done():
                    ready.set_result(src)
                await done.wait()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.info("mcp server %r unavailable: %s", ext.get("name"), e)
        finally:
            self._closers.discard(done)
            if not ready.done():
                ready.set_result(None)

    async def _connect(
        self, stack: contextlib.AsyncExitStack, ext: dict[str, Any]
    ) -> _Source:
        async with asyncio.timeout(CONNECT_TIMEOUT):
            if str(ext.get("transport") or "http") == "stdio":
                read, write = await stack.enter_async_context(
                    stdio_client(_stdio_params(ext))
                )
            else:
                endpoint = str(ext.get("endpoint") or "")
                if not endpoint:
                    raise ValueError("empty endpoint")
                # headers 原样全量透传（鉴权统一走这里：Authorization 或自定义头）
                headers = _str_dict(ext.get("headers"))
                client = await stack.enter_async_context(
                    create_mcp_http_client(headers=headers or None)
                )
                read, write = await stack.enter_async_context(
                    streamable_http_client(endpoint, http_client=client)
                )
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            listed = await session.list_tools()
        return _Source(
            sanitize(ext.get("name")), session, list(listed.tools or [])
        )

    async def _probe_async(self, ext: dict[str, Any]) -> dict[str, Any]:
        """probe 的 loop 侧实现：ExitStack 随协程退出即断开连接。"""
        try:
            async with contextlib.AsyncExitStack() as stack:
                src = await self._connect(stack, ext)
            return {"ok": True, "tools": len(src.tools)}
        except asyncio.CancelledError:
            raise
        except Exception as e:
            return {
                "ok": False,
                "tools": 0,
                "error": str(e) or type(e).__name__,
            }

    async def _close_async(self) -> None:
        for ev in self._closers:
            ev.set()
        tasks = self._tasks
        self._tasks = []
        self.current = ExtTools()
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=CLOSE_TIMEOUT,
                )
            except Exception:
                for t in tasks:
                    t.cancel()


@contextlib.contextmanager
def open_tools(extensions: Any, reserved: set[str]) -> Iterator[ExtTools]:
    """一回合可用的拓展工具集；退出时关闭连接。

    连不上/未配置的 server 直接不进工具表（不可用即不可见），
    任何失败都收敛为空集合，故这里没有异常路径。
    """
    tools = hub.open(extensions, reserved)
    try:
        yield tools
    finally:
        hub.close()


# 进程级单例：loop 线程惰性启动，挂到 interpreter 退出（daemon）。
hub = McpHub()
