"""拓展服务：MCP server 的注册与连通性探测。

分层约定：HTTP 层只与本层交互，不直接 import client/。
连接由 Cordis 宿主持有，Python 门面只做工具投影与权限校验。
"""

from __future__ import annotations

from typing import Any

from ..core.mcp import hub
from ..models import ProbeResult


def probe(ext: dict[str, Any]) -> ProbeResult:
    """使用独立宿主探测，不影响正在对话的常驻 MCP 连接。

    ext 来自设置页请求体（未校验），故按 dict 收；失败不抛错——
    不可达的 server 只是不可见，探测本身永不阻塞 UI。
    """
    return hub.probe(ext)


def configure(extensions: Any) -> None:
    """设置更新立即撤下禁用能力，再协调宿主连接生命周期。"""
    from .coordinator import runtime
    hub.bind(runtime)
    hub.configure(extensions)
