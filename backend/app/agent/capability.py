"""工具声明与执行：memory_add/search/update/delete + common_time。"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from .. import memory
from ..timeinfo import now_info

if TYPE_CHECKING:
    from .extend import ExtTools

# OpenAI function calling 工具声明
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "memory_add",
            "description": "新增一条普通记忆（关于用户或对话的重要事实）",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_search",
            "description": "搜索相关记忆，返回 [{id, content}]",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_update",
            "description": "更新一条已有普通记忆的内容（id 由 memory_search 或判重错误给出；初始记忆 pin 不可更新）",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["id", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory_delete",
            "description": "删除一条普通记忆（初始记忆 pin 不可删除）",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "common_time",
            "description": "获取当前 UTC 时间与本地时区",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def execute_tool(name: str, args: dict[str, Any]) -> str:
    """执行单个 tool call，返回字符串化结果（不向上抛）。"""
    try:
        if name == "memory_add":
            mem = memory.add_memory(str(args.get("content") or ""))
            return json.dumps({"ok": True, "id": mem["id"]}, ensure_ascii=False)
        if name == "memory_search":
            res = memory.search_memories(str(args.get("query") or ""))
            return json.dumps(res, ensure_ascii=False)
        if name == "memory_update":
            # 初始记忆是 memories 表的 pinned 行：工具不可改，只能设置页维护
            if memory.is_pinned(str(args.get("id") or "")):
                return "初始记忆（pin）不可通过记忆能力修改，请在设置中维护"
            memory.edit_memory(
                str(args.get("id") or ""), str(args.get("content") or "")
            )
            return json.dumps({"ok": True}, ensure_ascii=False)
        if name == "memory_delete":
            if memory.is_pinned(str(args.get("id") or "")):
                return "初始记忆（pin）不可删除"
            memory.delete_memory(str(args.get("id") or ""))
            return json.dumps({"ok": True}, ensure_ascii=False)
        if name == "common_time":
            return json.dumps(now_info(), ensure_ascii=False)
        return f"未知工具：{name}"
    except memory.MemoryError as e:
        return str(e)  # 校验/去重/不可删 → 说明文本回给模型
    except Exception as e:
        return f"工具执行失败：{e}"


def run_call(
    call: dict[str, Any], ext: ExtTools | None = None
) -> dict[str, Any]:
    """执行一条 tool_calls 元素，返回 role=tool 的消息。

    ext：本回合的 MCP 拓展工具表；名字命中时转发给对应 server
    （失败已由 ExtTools.call 文本化），否则走内置工具。
    """
    fn = call.get("function") or {}
    name = str(fn.get("name") or "")
    raw_args = fn.get("arguments") or "{}"
    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
        if not isinstance(args, dict):
            args = {}
    except Exception:
        return {
            "role": "tool",
            "tool_call_id": call.get("id") or "",
            "content": "工具参数解析失败",
        }
    if ext is not None and ext.has(name):
        content = ext.call(name, args)
    else:
        content = execute_tool(name, args)
    return {
        "role": "tool",
        "tool_call_id": call.get("id") or "",
        "content": content,
    }
