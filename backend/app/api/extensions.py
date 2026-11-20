"""拓展相关端点：POST /api/extensions/probe 单条 server 连通性探测。"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from ..services import extend
from ..models import ProbeResult

router = APIRouter()


@router.post("/api/extensions/probe")
def probe_extension(ext: dict[str, Any] = Body(...)) -> ProbeResult:
    """对一条拓展记录做 connect + list_tools + close 探测。

    body = 单条拓展配置 JSON（来自设置页，未校验故按 dict 收）；返回形状见 models.ProbeResult。
    失败不抛错——不可达的 server 只是不可见，探测本身永不阻塞 UI。
    """
    return extend.probe(ext)
