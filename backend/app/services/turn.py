"""一回合的编排：组装 → ReAct → 落账 → 切句推流。

对应 `meta/loop.md` 的主流程图——`run_turn` 的每一行就是图上的一个节点，
细节都在下方函数或别的层：

    build_messages    节点 B：system prompt + 摘要 + 最近窗口 + 本回合输入
    react             节点 R→D→E→CNT：LLM 调用与工具回填，≤5 轮
    checkpoint.*      user 落账 / assistant **逐句**落账（代际校验）
    compress.*        回合末按用量触发后台压缩（不阻塞推流）
    core.sentences    节点 H：切句（唯一口径，前端不再切句）
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterator

from ..core import llm, mcp
from ..core.sentences import split_sentences
from ..core import db
from ..core.state import load as load_state
from ..models import ChatMessage, ErrorEvent, State, StoredMessage, TurnEvent
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

        # 节点 H 前置：先触发压缩（不阻塞本回合推流）
        compress.maybe_compress(reply.prompt_tokens)

        # 节点 H：切句（唯一口径，已剥离指令）→ 逐句落账 → 推句事件。
        # 代际漂移（读档/打断）时静默丢弃剩余句子。
        for no, sent in enumerate(split_sentences(reply.text)):
            if not checkpoint.append_sentence(sent.text, gen, at):
                return
            yield {
                "t": "sentence",
                "no": no,
                "text": sent.text,
                "dirs": [
                    {"kind": d.kind, "name": d.name, "offset": d.offset}
                    for d in sent.dirs
                ],
                "at": at,
            }
            # (见文件末尾的过渡期 delta)
        # 过渡期兼容：给尚未切到句事件的前端发一次完整原文（含指令），
        # 它自己的切句器与指令解析器照旧工作 —— 行为与改造前完全一致。
        # 前端切到句事件后删掉这一行。
        yield {"t": "delta", "text": reply.text}


# ==================== 节点实现 ====================


def build_messages(state: State, text: str) -> list[ChatMessage]:
    """节点 B：system prompt + 压缩摘要（若有）+ 最近窗口 history + 本回合输入。"""
    messages: list[ChatMessage] = [
        {"role": "system", "content": build_system_prompt(state, memory.pins())}
    ]
    summary = checkpoint.live_summary().strip()
    if summary:
        messages.append({"role": "system", "content": SUMMARY_PREFIX + summary})
    for past in _merge_assistant(checkpoint.live_messages())[-HISTORY_WINDOW:]:
        messages.append(past)
    messages.append({"role": "user", "content": text})
    return messages


def _merge_assistant(msgs: list[StoredMessage]) -> list[ChatMessage]:
    """把同一回合的多条 assistant 句子合并回一条，再进历史窗口。

    句级落库后，一回合在 DB 里是 N 条连续 assistant 行；直接回放会让模型看到
    「一回合 N 条 assistant」，干扰它对对话结构的判断（同类项目踩过这个坑：
    hermes-agent 的 "merge consecutive assistant messages before API replay"）。
    合并后再取窗口，上下文与改造前等价 —— 因此 HISTORY_WINDOW 的语义不必改。

    回合边界由 user 行界定，故「连续 assistant 必属同回合」成立。
    """
    out: list[ChatMessage] = []
    for m in msgs:
        # role 过滤是防御（老数据/手工写入）：正常落库只有 user/assistant
        if m["role"] not in ("user", "assistant"):
            continue
        if m["role"] == "assistant" and out and out[-1]["role"] == "assistant":
            out[-1]["content"] += m["text"]
        else:
            out.append({"role": m["role"], "content": m["text"]})
    return out


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
