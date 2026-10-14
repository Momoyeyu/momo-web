"""OpenAI 兼容 embeddings client。

env：MOMO_EMBEDDING_URL / MOMO_EMBEDDING_MODEL。
失败（超时/不可达/坏响应）一律降级返回 None，由调用方走 lexical 兜底。
"""
from __future__ import annotations

import os

import httpx

EMBEDDING_URL = os.environ.get(
    "MOMO_EMBEDDING_URL", "http://10.106.130.222:11434"
).rstrip("/")
EMBEDDING_MODEL = os.environ.get("MOMO_EMBEDDING_MODEL", "bge-m3")
TIMEOUT = 5.0


def embed(text: str) -> list[float] | None:
    """POST {url}/v1/embeddings → data[0].embedding；任何失败返回 None。"""
    try:
        resp = httpx.post(
            f"{EMBEDDING_URL}/v1/embeddings",
            json={"model": EMBEDDING_MODEL, "input": text},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        vec = resp.json()["data"][0]["embedding"]
        return [float(x) for x in vec]
    except Exception:
        return None
