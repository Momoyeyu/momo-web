"""工具声明与执行：memory.add/search/delete + common.time。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .. import memory

# OpenAI function calling 工具声明
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "memory.add",
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
            "name": "memory.search",
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
            "name": "memory.delete",
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
            "name": "common.time",
            "description": "获取 backend 本机当前时间",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def execute_tool(name: str, args: dict[str, Any], pins: list[str]) -> str:
    """执行单个 tool call，返回字符串化结果（不向上抛）。"""
    try:
        if name == "memory.add":
            mem = memory.add_memory(str(args.get("content") or ""), pins=pins)
            return json.dumps({"ok": True, "id": mem["id"]}, ensure_ascii=False)
        if name == "memory.search":
            res = memory.search_memories(str(args.get("query") or ""), pins=pins)
            return json.dumps(res, ensure_ascii=False)
        if name == "memory.delete":
            memory.delete_memory(str(args.get("id") or ""))
            return json.dumps({"ok": True}, ensure_ascii=False)
        if name == "common.time":
            now = datetime.now().astimezone()
            return json.dumps(
                {"iso": now.isoformat(timespec="seconds"), "tz": now.tzname() or ""},
                ensure_ascii=False,
            )
        return f"未知工具：{name}"
    except memory.MemoryError as e:
        return str(e)  # 校验/去重/不可删 → 说明文本回给模型
    except Exception as e:
        return f"工具执行失败：{e}"


def run_call(call: dict[str, Any], pins: list[str]) -> dict[str, Any]:
    """执行一条 tool_calls 元素，返回 role=tool 的消息。"""
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
    return {
        "role": "tool",
        "tool_call_id": call.get("id") or "",
        "content": execute_tool(name, args, pins),
    }
