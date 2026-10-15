"""OpenAI 兼容 embeddings client。

配置来自 state.settings.embedding（{url, key, model}，设置页可改）；
DEFAULT_URL/DEFAULT_MODEL 是出厂默认（可被 env 覆盖），
store.py 拿它们填 DEFAULT_STATE。
url 为空 = 未配置 → 返回 None；其余失败（超时/不可达/坏响应）
同样返回 None，由调用方走 lexical 兜底。
"""
from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_URL = os.environ.get(
    "MOMO_EMBEDDING_URL", "http://10.106.130.222:11434"
).rstrip("/")
DEFAULT_MODEL = os.environ.get("MOMO_EMBEDDING_MODEL", "bge-m3")
TIMEOUT = 5.0


def embed(text: str, cfg: dict[str, Any] | None = None) -> list[float] | None:
    """POST {url}/v1/embeddings → data[0].embedding；任何失败返回 None。"""
    cfg = cfg or {}
    url = str(cfg.get("url") or "").rstrip("/")
    if not url:
        return None
    model = str(cfg.get("model") or "") or DEFAULT_MODEL
    headers: dict[str, str] = {}
    key = str(cfg.get("key") or "")
    if key:
        headers["Authorization"] = f"Bearer {key}"
    try:
        resp = httpx.post(
            f"{url}/v1/embeddings",
            json={"model": model, "input": text},
            headers=headers,
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        vec = resp.json()["data"][0]["embedding"]
        return [float(x) for x in vec]
    except Exception:
        return None
