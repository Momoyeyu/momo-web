"""一回合的编排：组装 → ReAct → 落账 → 切句推流。

对应 `meta/loop.md` 的主流程图——`run_turn` 的每一行就是图上的一个节点，
细节都在下方函数或别的层：

    build_messages    节点 B：system prompt + 摘要 + 最近窗口 + 本回合输入
    react             节点 R→D→E→CNT：LLM 调用与工具回填，≤5 轮
    checkpoint.*      user 落账 / assistant 落账（代际校验）
    compress.*        回合末按用量触发后台压缩（不阻塞推流）
    common.sentences  节点 H：切句
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator

from ..core import llm, mcp
from ..core.directives import strip_directives
from ..core.sentences import split_segments
from ..core import db
from ..core.state import load as load_state
from ..models import ChatMessage, ErrorEvent, State, TurnEvent
from . import checkpoint, compress, memory
from .capability import TOOLS, builtin_names, run_call
from .prompt import build_system_prompt

MAX_ROUNDS = 5
HISTORY_WINDOW = 20

SUMMARY_PREFIX = "以下是本次对话此前部分的摘要，其后的最新消息接在它之后继续：\n"


@dataclass(frozen=True)
class Reply:
    """`react` 的结果：成功带正文与用量，失败带 error 事件。"""

    text: str = ""
    prompt_tokens: int | None = None
    error: ErrorEvent | None = None


# ==================== 主流程 ====================


def run_turn(text: str) -> Iterator[TurnEvent]:
    """一回合：yield 增量/错误事件（结束即返回）。流程见 meta/loop.md。"""
    state = load_state()
    messages = build_messages(state, text)  # 节点 B

    at, gen = db.now_iso(), checkpoint.generation()  # 代际快照
    if not checkpoint.begin_turn(text, gen, at):
        return  # 会话已被读档/重置 → 本回合静默作废

    with mcp.open_tools(state["settings"]["extensions"], builtin_names()) as ext_tools:
        reply = react(messages, ext_tools, state)  # 节点 R→D→E→CNT
        if reply.error is not None:
            yield reply.error  # 节点 ERR（不发 done，由 api 层决定）
            return

        # 节点 G：指令剥离后落账；代际漂移（读档/打断）则静默收尾
        if not checkpoint.commit_reply(strip_directives(reply.text), gen, at):
            return
        compress.maybe_compress(reply.prompt_tokens)  # 不阻塞本回合推流

        for segment in split_segments(reply.text):  # 节点 H
            yield {"t": "delta", "text": segment}


# ==================== 节点实现 ====================


def build_messages(state: State, text: str) -> list[ChatMessage]:
    """节点 B：system prompt + 压缩摘要（若有）+ 最近窗口 history + 本回合输入。"""
    messages: list[ChatMessage] = [
        {"role": "system", "content": build_system_prompt(state, memory.pins())}
    ]
    summary = checkpoint.live_summary().strip()
    if summary:
        messages.append({"role": "system", "content": SUMMARY_PREFIX + summary})
    for past in checkpoint.live_messages()[-HISTORY_WINDOW:]:
        # role 过滤是防御（老数据/手工写入）：正常落库只有 user/assistant
        if past["role"] in ("user", "assistant"):
            messages.append({"role": past["role"], "content": past["text"]})
    messages.append({"role": "user", "content": text})
    return messages


def react(
    messages: list[ChatMessage], ext_tools: mcp.ExtTools, state: State
) -> Reply:
    """节点 R→D→E→CNT：调 LLM；有 tool_calls 就执行回填继续，拿到正文即结束。

    最多 MAX_ROUNDS 次调用（tool 轮与空 content 轮同样计数）。
    工具表：无可用拓展时原样下发内置表（`TOOLS` 本身，不做拷贝）。
    """
    tools = TOOLS + ext_tools.decls if ext_tools.decls else TOOLS
    llm_cfg = state["settings"]["llm"]
    usage: dict[str, Any] = {}  # 末次调用的用量（压缩阈值判定用）

    for _ in range(MAX_ROUNDS):
        try:
            message = llm.chat_completion(
                llm_cfg, messages, tools=tools, usage_out=usage
            )
        except llm.LlmError as e:
            return Reply(error=_error(str(e)))

        tool_calls = message.get("tool_calls") or []
        if tool_calls:
            messages.append(message)  # assistant（含 tool_calls）原样回传
            for call in tool_calls:
                messages.append(run_call(call, ext_tools))
            continue

        content = str(message.get("content") or "")
        if content.strip():
            return Reply(text=content, prompt_tokens=usage.get("prompt_tokens"))
        # 空 content 且无 tool_calls：记一轮，继续重试

    return Reply(error=_error(f"llm produced no response within {MAX_ROUNDS} rounds"))


def _error(message: str) -> ErrorEvent:
    return {"t": "error", "message": message, "service": "llm"}
