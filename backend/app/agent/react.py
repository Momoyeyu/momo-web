"""ReAct 循环：LLM ↔ 工具调用，直到拿到正文。

run_turn(text) 是生成器：yield SSE 事件 dict（delta/error）。
history 由本模块在回合结束时追加并落盘（cap 100）。
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Iterator

from .. import llm, store
from . import compress, mcp_ext
from .prompts import build_system_prompt
from .tools import TOOLS, run_call

MAX_ROUNDS = 5
HISTORY_WINDOW = 20

_DELTA_DELIMS = "。！？!?…\n"

# 落库前剥离表情/动作指令：history 会回喂给下一轮 LLM，指令标记
# 留在上下文里只会教会模型继续输出旧格式。#tag 是上一代语法的残留
# 习惯，同样剥除（值清单固定——仅是文本清洗，不再驱动资源）。
_RE_DIRECTIVE = re.compile(r"<(exp|motion)>[^<]*</\1>[^\S\n]*")
_RE_LEGACY_TAG = re.compile(
    r"(?<![\w#])#(?:neutral|happy|sad|angry|surprised|thinking|shy|sleepy)\b"
    r"[^\S\n]*"  # 同行的尾随空白一并吃掉（不吞换行）
)


def _clean_reply(text: str) -> str:
    """剥离 <exp>/<motion> 指令与旧版 #tag，返回可展示/落库的正文。"""
    s = _RE_DIRECTIVE.sub("", text)
    s = _RE_LEGACY_TAG.sub("", s)
    # 指令移除后行首可能残留空白
    return "\n".join(line.lstrip() for line in s.split("\n")).strip()


def split_segments(text: str) -> list[str]:
    """按标点（。！？!?…\\n）切段，保留标点；无标点时整段返回。"""
    segs: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in _DELTA_DELIMS:
            segs.append(buf)
            buf = ""
    if buf:
        segs.append(buf)
    return segs or [text]


def run_turn(text: str) -> Iterator[dict[str, Any]]:
    """一回合：yield {"t":"delta",...} 或 {"t":"error",...}（结束即返回）。

    无 tool_calls 的 content 切段作为 delta；5 轮仍无 content → error。
    """
    state = store.normalize_state(store.read_state())
    pins = [p for p in (state.get("pins") or []) if isinstance(p, str)]
    llm_cfg = (state.get("settings") or {}).get("llm") or {}

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": build_system_prompt(state)}
    ]
    # 压缩摘要存在时单独一条 system 消息承载：context = system + 摘要 + 最近窗口
    summary = str(state.get("summary") or "").strip()
    if summary:
        messages.append(
            {
                "role": "system",
                "content": "以下是本次对话此前部分的摘要，其后的最新消息接在它之后继续：\n"
                + summary,
            }
        )
    for h in (state.get("history") or [])[-HISTORY_WINDOW:]:
        role = h.get("role")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": str(h.get("text") or "")})
    messages.append({"role": "user", "content": text})

    # 拓展：连接 enabled 的 MCP server（连不上即不注入，失败不拖垮回合），
    # 工具以 {server}_{tool} 注入；turn 结束统一关闭连接。
    ext_tools = mcp_ext.ExtTools()
    try:
        ext_tools = mcp_ext.hub.open(
            (state.get("settings") or {}).get("extensions")
        )
        # 无可用拓展时 tools 就是静态 TOOLS（行为与现状一致）
        tools = TOOLS + ext_tools.decls if ext_tools.decls else TOOLS

        content = ""
        # 本回合末次调用的 token 用量（压缩阈值判定用）
        usage: dict[str, Any] = {}
        for _ in range(MAX_ROUNDS):
            try:
                msg = llm.chat_completion(
                    llm_cfg, messages, tools=tools, usage_out=usage
                )
            except llm.LlmError as e:
                yield {"t": "error", "message": str(e), "service": "llm"}
                return

            tool_calls = msg.get("tool_calls") or []
            if tool_calls:
                messages.append(msg)  # assistant（含 tool_calls）原样回传
                for call in tool_calls:
                    messages.append(run_call(call, pins, ext_tools))
                continue

            content = str(msg.get("content") or "")
            if content.strip():
                break
            # 空 content 且无 tool_calls：记一轮，继续重试
        else:
            yield {
                "t": "error",
                "message": "llm produced no response within 5 rounds",
                "service": "llm",
            }
            return

        # 回合结束：user/assistant（指令剥离后）追加进 history（cap 100）并落盘，再推流
        at = datetime.now(timezone.utc).isoformat()
        store.append_history(
            [
                {"role": "user", "text": text, "at": at},
                {"role": "assistant", "text": _clean_reply(content), "at": at},
            ]
        )
        # 用量达阈值 → 后台压缩最旧段（不阻塞本回合推流）
        compress.maybe_compress(usage.get("prompt_tokens"))
        for seg in split_segments(content):
            yield {"t": "delta", "text": seg}
    finally:
        mcp_ext.hub.close()
