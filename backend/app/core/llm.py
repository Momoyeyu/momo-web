"""OpenAI 兼容 chat client（流式 + 非流式，均支持 tools/tool_calls）。

- chat_stream：一轮的流式调用。文本增量与工具调用增量在同一条 assistant 消息里
  交错下发，因此**一轮里文本可以出现多次**（工具调用前后都能说话）——
  ReAct 循环据此把正文边到边切句推给前端，用户在生成过程中就能看到前几句。
- chat_completion：非流式，供压缩摘要等不需要流式的场景使用。

调用方传 state.settings.llm 配置；错误统一抛 LlmError，message 语义化。
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Iterator

import httpx

if TYPE_CHECKING:
    from ..models import ChatMessage


TIMEOUT = 60.0


class LlmError(Exception):
    """LLM 调用失败；str(e) 直接作为 SSE error 事件的 message。"""


def chat_completion(
    llm_cfg: dict[str, Any],
    messages: list[ChatMessage],
    tools: list[dict[str, Any]] | None = None,
    usage_out: dict[str, Any] | None = None,
) -> ChatMessage:
    """POST {url}/v1/chat/completions → choices[0].message（形状见 models.ChatMessage）。

    失败抛 LlmError。usage_out 传入 dict 时清原值并写入响应的 usage
    （压缩阈值判定用）。
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

    headers: dict[str, str] = {}
    key = llm_cfg.get("key") or ""
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        resp = httpx.post(
            f"{url}/v1/chat/completions",
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
        message = data["choices"][0]["message"]
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
) -> Iterator[dict[str, Any]]:
    """流式跑一轮，逐条 yield：

        {"type": "text", "delta": "…"}              正文增量（可能 0..n 次）
        {"type": "tool_calls", "calls": [...]}      本轮要调用的工具（至多一次，最后）

    工具调用参数在 OpenAI 协议里是**分片**下发的，必须按 index 累积后再解析，
    不能拿单片去 json.loads。失败抛 LlmError。
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

    headers: dict[str, str] = {}
    key = llm_cfg.get("key") or ""
    if key:
        headers["Authorization"] = f"Bearer {key}"

    slots: dict[int, dict[str, Any]] = {}
    try:
        with httpx.stream(
            "POST",
            f"{url}/v1/chat/completions",
            json=payload,
            headers=headers,
            timeout=TIMEOUT,
        ) as resp:
            if resp.status_code != 200:
                raise LlmError(f"http {resp.status_code}")
            for line in resp.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except Exception:
                    continue  # 半截/注释行：跳过
                if usage_out is not None:
                    usage = chunk.get("usage")
                    if isinstance(usage, dict):
                        usage_out.clear()
                        usage_out.update(usage)
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = choices[0].get("delta") or {}
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

    if slots:
        yield {"type": "tool_calls", "calls": [slots[i] for i in sorted(slots)]}
