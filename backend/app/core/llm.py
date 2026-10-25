"""OpenAI 兼容 chat client（流式 + 非流式，均支持 tools/tool_calls）。

- chat_stream：一轮的流式调用。文本增量与工具调用增量在同一条 assistant 消息里
  交错下发，因此**一轮里文本可以出现多次**（工具调用前后都能说话）——
  ReAct 循环据此把正文边到边切句推给前端，用户在生成过程中就能看到前几句。
- chat_completion：非流式，供压缩摘要等不需要流式的场景使用。

调用方传 state.settings.llm 配置；错误统一抛 LlmError，message 语义化。
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Callable, Iterator
from urllib.parse import urlsplit

import httpx

if TYPE_CHECKING:
    from ..models import ChatMessage


TIMEOUT = 60.0


class LlmError(Exception):
    """LLM 调用失败；str(e) 直接作为 SSE error 事件的 message。"""


def _thinking_payload(llm_cfg: dict[str, Any], payload: dict[str, Any]) -> None:
    """Apply the trusted DeepSeek protocol to a private request copy.

    Persisted dialogue lacks reasoning by design. Missing historical fields use
    empty strings for tools-enabled replay; current tool rounds retain full
    reasoning in the request-local messages.
    """
    enabled = llm_cfg.get("thinking") is True
    try:
        host = urlsplit(str(llm_cfg.get("url") or "")).hostname
    except ValueError:
        host = None
    if host != "api.deepseek.com":
        if enabled:
            raise LlmError("native thinking is not supported for this provider")
        return
    payload["thinking"] = {"type": "enabled" if enabled else "disabled"}
    if enabled and payload.get("tools"):
        payload["messages"] = [
            {**m, "reasoning_content": m.get("reasoning_content") or ""}
            if m.get("role") == "assistant" else dict(m)
            for m in payload["messages"]
        ]


def chat_completion(
    llm_cfg: dict[str, Any],
    messages: list[ChatMessage],
    tools: list[dict[str, Any]] | None = None,
    usage_out: dict[str, Any] | None = None,
    reasoning_out: dict[str, Any] | None = None,
) -> ChatMessage:
    """POST {url}/v1/chat/completions → choices[0].message（形状见 models.ChatMessage）。

    失败抛 LlmError。usage_out 传入 dict 时清原值并写入响应的 usage
    （压缩阈值判定用）。reasoning_content 从返回消息剥离，仅在调用方显式
    传入 reasoning_out 时存入该请求内的临时字典。
    """
    url = str(llm_cfg.get("url") or "").rstrip("/")
    if not url:
        raise LlmError("llm url not configured")

    payload: dict[str, Any] = {
        "model": llm_cfg.get("model") or "",
        "messages": messages,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    _thinking_payload(llm_cfg, payload)
    if usage_out is not None:
        usage_out.clear()
    if reasoning_out is not None:
        reasoning_out.clear()

    headers: dict[str, str] = {}
    key = llm_cfg.get("key") or ""
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        resp = httpx.post(
            f"{url}/v1/chat/completions",
            trust_env=False,
            json=payload,
            headers=headers,
            timeout=TIMEOUT,
        )
    except httpx.TimeoutException as e:
        raise LlmError("llm timeout") from e
    except httpx.HTTPError as e:
        raise LlmError("llm unreachable") from e

    if resp.status_code != 200:
        raise LlmError(f"http {resp.status_code}")

    try:
        data = resp.json()
        message = dict(data["choices"][0]["message"])
        reasoning = message.pop("reasoning_content", None)
        if reasoning_out is not None and isinstance(reasoning, str):
            reasoning_out["reasoning_content"] = reasoning
    except Exception as e:
        raise LlmError("bad llm response") from e
    if usage_out is not None:
        usage_out.clear()
        usage = data.get("usage")
        if isinstance(usage, dict):
            usage_out.update(usage)
    return message


def chat_stream(
    llm_cfg: dict[str, Any],
    messages: list[ChatMessage],
    tools: list[dict[str, Any]] | None = None,
    usage_out: dict[str, Any] | None = None,
    reasoning_out: dict[str, Any] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> Iterator[dict[str, Any]]:
    """流式跑一轮，逐条 yield：

        {"type": "text", "delta": "…"}              正文增量（可能 0..n 次）
        {"type": "tool_calls", "calls": [...]}      本轮要调用的工具（至多一次，最后）

    工具调用参数在 OpenAI 协议里是**分片**下发的，必须按 index 累积后再解析，
    不能拿单片去 json.loads。失败抛 LlmError。reasoning_out 仅用于本回合
    的工具协议回填，不会 yield。cancelled 每条 SSE 行都校验（包括思考片段）；
    完全无数据的同步网络读取仍受 TIMEOUT 约束。
    """
    url = str(llm_cfg.get("url") or "").rstrip("/")
    if not url:
        raise LlmError("llm url not configured")

    payload: dict[str, Any] = {
        "model": llm_cfg.get("model") or "",
        "messages": messages,
        "stream": True,
        # 多数 OpenAI 兼容服务需要显式要求才在流里带 usage
        "stream_options": {"include_usage": True},
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    _thinking_payload(llm_cfg, payload)
    if usage_out is not None:
        usage_out.clear()
    if reasoning_out is not None:
        reasoning_out.clear()

    headers: dict[str, str] = {}
    key = llm_cfg.get("key") or ""
    if key:
        headers["Authorization"] = f"Bearer {key}"

    slots: dict[int, dict[str, Any]] = {}
    if cancelled and cancelled():
        return
    try:
        with httpx.stream(
            "POST",
            f"{url}/v1/chat/completions",
            trust_env=False,
            json=payload,
            headers=headers,
            timeout=TIMEOUT,
        ) as resp:
            if resp.status_code != 200:
                raise LlmError(f"http {resp.status_code}")
            for line in resp.iter_lines():
                if cancelled and cancelled():
                    return
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except Exception:
                    continue  # 半截/注释行：跳过
                if not isinstance(chunk, dict):
                    raise LlmError("bad llm response")
                if chunk.get("error"):
                    raise LlmError("llm stream error")
                if usage_out is not None:
                    usage = chunk.get("usage")
                    if isinstance(usage, dict):
                        usage_out.clear()
                        usage_out.update(usage)
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
                reasoning = delta.get("reasoning_content")
                if reasoning_out is not None and isinstance(reasoning, str):
                    reasoning_out["reasoning_content"] = (
                        reasoning_out.get("reasoning_content", "") + reasoning
                    )
                text = delta.get("content")
                if text:
                    yield {"type": "text", "delta": text}
                for tc in delta.get("tool_calls") or []:
                    idx = int(tc.get("index") or 0)
                    slot = slots.setdefault(
                        idx,
                        {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        },
                    )
                    if tc.get("id"):
                        slot["id"] = str(tc["id"])
                    fn = tc.get("function") or {}
                    # name 一般整块下发一次：直接赋值，别累加（累加会翻倍）
                    if fn.get("name"):
                        slot["function"]["name"] = str(fn["name"])
                    if fn.get("arguments"):
                        slot["function"]["arguments"] += str(fn["arguments"])
    except httpx.TimeoutException as e:
        raise LlmError("llm timeout") from e
    except httpx.HTTPError as e:
        raise LlmError("llm unreachable") from e

    if cancelled and cancelled():
        return
    if slots:
        yield {"type": "tool_calls", "calls": [slots[i] for i in sorted(slots)]}
