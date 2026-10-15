"""data/state.json 读写与默认值归一化。

state.json 是唯一持久化（gitignored）。读取时做 defaults 深合并：
缺失键补默认值，多余键原样透传（前端字段后端不消费的也保留）。
"""
from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any, Callable

from .embed import DEFAULT_MODEL, DEFAULT_URL

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
STATE_PATH = DATA_DIR / "state.json"

# 内置 Hiyori 的资源清单（与前端 BUILTIN_RESOURCES 保持一致；
# 前端 manifest 解析才是权威源，这里是后端兜底默认）。
# desc 语义沿用旧情绪映射表的选型，可在设置页修改。
_BUILTIN_AVATAR: dict[str, Any] = {
    "id": "builtin",
    "builtin": True,
    "name": "Hiyori",
    "fileName": "",
    "manifest": "Hiyori.model3.json",
    "size": 0,
    "addedAt": "",
    "resources": {
        "expressions": [],
        "motions": [
            {"name": "Idle/0", "desc": "待机轻晃"},
            {"name": "Idle/1", "desc": "待机动作"},
            {"name": "Idle/2", "desc": "害羞地低头"},
            {"name": "Idle/3", "desc": "待机动作"},
            {"name": "Idle/4", "desc": "思考的样子"},
            {"name": "Idle/5", "desc": "惊讶"},
            {"name": "Idle/6", "desc": "难过"},
            {"name": "Idle/7", "desc": "生气"},
            {"name": "Idle/8", "desc": "困倦"},
            {"name": "TapBody/0", "desc": "开心地蹦一下"},
        ],
    },
}

# 缺省 state：仅覆盖后端消费的字段（settings/persona/avatars），
# 其余前端字段由 PUT body 透传。
DEFAULT_STATE: dict[str, Any] = {
    "settings": {
        "general": {
            "lang": "zh",
            "chatLang": "auto",
            "dialogOpacity": 66,
            "textSpeed": 60,
            "sentenceSpeed": 60,
            "voiceVolume": 100,
            "showStatus": True,
            "voiceInput": True,
            "semanticSearch": True,
        },
        "llm": {"url": "", "key": "", "model": ""},
        "asr": {"url": "", "key": ""},
        "tts": {"url": "", "key": "", "voice": "", "lang": "zh"},
        # 语义检索端点（设置页「模型」tab 可改）；url 留空 = 只用词面召回
        "embedding": {"url": DEFAULT_URL, "key": "", "model": DEFAULT_MODEL},
        # MCP 拓展清单（{name,transport,command?,endpoint?,apiKey?,enabled}）
        "extensions": [],
    },
    # 与前端 DEFAULT_PERSONA 保持一致：prompt 组装时空字段回落到这里。
    "persona": {
        "name": "momo",
        "identity": "由夜羽开发的AI",
        "age": 16,
        "personality": "乖巧听话",
        "preferences": ["喜欢草莓蛋糕", "讨厌苦的东西"],
    },
    "avatars": [_BUILTIN_AVATAR],
    "avatarId": "builtin",
    # pins/history/summary 已迁 momo.db（memories.pinned / live 会话行），
    # 不再走 state.json。
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
    merged = _merge(DEFAULT_STATE, state if isinstance(state, dict) else {})
    # 内置形象条目恒存在（avatars 是整体替换的数组，深合并补不了成员缺失）。
    avatars = merged.get("avatars")
    if not isinstance(avatars, list):
        merged["avatars"] = [copy.deepcopy(_BUILTIN_AVATAR)]
    elif not any(
        isinstance(a, dict) and a.get("id") == "builtin" for a in avatars
    ):
        avatars.insert(0, copy.deepcopy(_BUILTIN_AVATAR))
    return merged


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


# state.json 读-改-写锁：保给将来需要原子 read-modify-write 的配置字段。
_STATE_LOCK = threading.Lock()


def update_state(mutate: Callable[[dict[str, Any]], Any]) -> Any:
    """锁内 read-modify-write state.json，返回 mutate 的结果。

    mutate 返回 False 时跳过写盘（用于「前提不成立则放弃」的原子检查）。
    """
    with _STATE_LOCK:
        state = normalize_state(read_state())
        result = mutate(state)
        if result is not False:
            write_state(state)
        return result
