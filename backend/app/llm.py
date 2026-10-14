"""OpenAI 兼容 chat client（非流式，支持 tools/tool_calls）。

调用方传 state.settings.llm 配置；错误统一抛 LlmError，message 语义化。
"""
from __future__ import annotations

from typing import Any

import httpx

TIMEOUT = 60.0


class LlmError(Exception):
    """LLM 调用失败；str(e) 直接作为 SSE error 事件的 message。"""


def chat_completion(
    llm_cfg: dict[str, Any],
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """POST {url}/v1/chat/completions → choices[0].message。

    返回 message dict（含 role/content/tool_calls）。失败抛 LlmError。
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
        return resp.json()["choices"][0]["message"]
    except Exception as e:
        raise LlmError("bad llm response") from e
