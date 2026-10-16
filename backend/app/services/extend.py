"""拓展服务：MCP server 的注册与连通性探测。

分层约定：HTTP 层只与本层交互，不直接 import client/。
真正的连接、工具适配与跨线程桥在 `app/core/mcp.py`。
"""

from __future__ import annotations

from typing import Any

from ..core.mcp import hub
from ..models import ProbeResult


def probe(ext: dict[str, Any]) -> ProbeResult:
    """探测一条拓展记录：connect + list_tools + close。

    ext 来自设置页请求体（未校验），故按 dict 收；失败不抛错——
    不可达的 server 只是不可见，探测本身永不阻塞 UI。
    """
    return hub.probe(ext)
