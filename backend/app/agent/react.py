"""ReAct 循环：LLM ↔ 工具调用，直到拿到正文。

run_turn(text) 是生成器：yield SSE 事件 dict（delta/error）。
history 由本模块在回合结束时追加并落盘（cap 100）。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterator

from .. import llm, store
from .prompts import build_system_prompt
from .tools import TOOLS, run_call

MAX_ROUNDS = 5
HISTORY_WINDOW = 20

_DELTA_DELIMS = "。！？!?…\n"


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
    for h in (state.get("history") or [])[-HISTORY_WINDOW:]:
        role = h.get("role")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": str(h.get("text") or "")})
    messages.append({"role": "user", "content": text})

    content = ""
    for _ in range(MAX_ROUNDS):
        try:
            msg = llm.chat_completion(llm_cfg, messages, tools=TOOLS)
        except llm.LlmError as e:
            yield {"t": "error", "message": str(e), "service": "llm"}
            return

        tool_calls = msg.get("tool_calls") or []
        if tool_calls:
            messages.append(msg)  # assistant（含 tool_calls）原样回传
            for call in tool_calls:
                messages.append(run_call(call, pins))
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

    # 回合结束：user/assistant 追加进 history（cap 100）并落盘，再推流
    at = datetime.now(timezone.utc).isoformat()
    store.append_history(
        [
            {"role": "user", "text": text, "at": at},
            {"role": "assistant", "text": content, "at": at},
        ]
    )
    for seg in split_segments(content):
        yield {"t": "delta", "text": seg}
