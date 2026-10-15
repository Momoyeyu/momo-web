"""拓展相关端点：POST /api/extensions/probe 单条 server 连通性探测。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from ..agent.extend import hub

router = APIRouter()


@router.post("/api/extensions/probe")
def probe_extension(ext: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """对一条拓展记录做 connect + list_tools + close 探测。

    body = 单条拓展配置 JSON；返回 {"ok": bool, "tools": int, "error"?: str}。
    失败不抛错——不可达的 server 只是不可见，探测本身永不阻塞 UI。
    """
    return hub.probe(ext)
