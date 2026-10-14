"""data/state.json 读写与默认值归一化。

state.json 是唯一持久化（gitignored）。读取时做 defaults 深合并：
缺失键补默认值，多余键原样透传（前端字段后端不消费的也保留）。
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from .embed import DEFAULT_MODEL, DEFAULT_URL

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
STATE_PATH = DATA_DIR / "state.json"

# 缺省 state：仅覆盖后端消费的字段（settings/persona/pins/history），
# 其余前端字段由 PUT body 透传。
DEFAULT_STATE: dict[str, Any] = {
    "settings": {
        "general": {
            "lang": "zh",
            "dialogOpacity": 66,
            "voiceVolume": 100,
            "showStatus": True,
        },
        "llm": {"url": "", "key": "", "model": ""},
        "asr": {"url": "", "key": ""},
        "tts": {"url": "", "key": "", "voice": "", "lang": "zh"},
        # 语义检索端点（设置页「模型」tab 可改）；url 留空 = 只用词面召回
        "embedding": {"url": DEFAULT_URL, "model": DEFAULT_MODEL},
    },
    # 与前端 DEFAULT_PERSONA 保持一致：prompt 组装时空字段回落到这里。
    "persona": {
        "name": "momo",
        "identity": "AI",
        "age": 16,
        "personality": "乖巧听话",
        "preferences": ["喜欢草莓蛋糕", "讨厌苦的食物"],
    },
    "pins": [],
    "avatars": [],
    "avatarId": "builtin",
    "history": [],
}


def _merge(defaults: Any, value: Any) -> Any:
    """深合并：value 优先，defaults 补缺；None 视为缺失。"""
    if isinstance(defaults, dict) and isinstance(value, dict):
        merged = copy.deepcopy(value)
        for k, dv in defaults.items():
            merged[k] = _merge(dv, value.get(k))
        return merged
    if value is None:
        return copy.deepcopy(defaults)
    return value


def normalize_state(state: dict[str, Any] | None) -> dict[str, Any]:
    """任意（可能残缺/旧 schema）state → 合并默认值后的完整 state。"""
    return _merge(DEFAULT_STATE, state if isinstance(state, dict) else {})


def read_state() -> dict[str, Any] | None:
    """读原始 state；文件不存在或 JSON 损坏返回 None。"""
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def write_state(state: dict[str, Any]) -> None:
    """整体写入 state.json（不做归一化，读取时再合并默认值）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_state() -> dict[str, Any]:
    """GET /api/state 用：无文件返回 {}，否则返回归一化后的完整 state。"""
    raw = read_state()
    if raw is None:
        return {}
    return normalize_state(raw)


def append_history(entries: list[dict[str, Any]], cap: int = 100) -> None:
    """追加对话历史（cap 100）并落盘。"""
    state = normalize_state(read_state())
    history = list(state.get("history") or [])
    history.extend(entries)
    state["history"] = history[-cap:]
    write_state(state)
