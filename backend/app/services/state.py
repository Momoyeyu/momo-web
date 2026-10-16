"""配置服务：momo.yaml 的整体读写。

分层约定：HTTP 层只与本层交互，不直接 import config/。
YAML 读写与默认值归一化在 `app/core/state.py`。

这里暂时只是透传——留这一层是为了让「api → service → config」这条线
无条件成立（可被 tests/test_layering.py 机械检查），也给将来的载荷校验/
迁移逻辑一个落脚点。
"""

from __future__ import annotations

from typing import Any

from ..core import state as config


def read() -> dict[str, Any]:
    """完整配置 JSON；尚无 momo.yaml 时返回空对象（前端据此判「未配置」）。"""
    return config.get_state()


def replace(payload: dict[str, Any]) -> None:
    """整体替换配置。"""
    config.write_state(payload)
