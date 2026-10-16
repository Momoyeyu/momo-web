"""data/momo.yaml 读写与默认值归一化。

momo.yaml 是配置层持久化（gitignored）。读取时做 defaults 深合并：
缺失键补默认值，多余键原样透传（前端字段后端不消费的也保留）。
"""
from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

if TYPE_CHECKING:
    from ..models import State


# 出厂默认：embedding 端点与模型（env 可覆盖）。放 core 层，
# 这样 core 不反向依赖任何上层（models/services/api）。
DEFAULT_EMBEDDING_URL = os.environ.get("MOMO_EMBEDDING_URL", "").rstrip("/")
DEFAULT_EMBEDDING_MODEL = os.environ.get("MOMO_EMBEDDING_MODEL", "bge-m3")

# 数据目录（momo.db + momo.yaml）。env 可覆盖——用于测试隔离与多实例共存，
# 免得跑集成测试时写坏真实配置。
DATA_DIR = Path(
    os.environ.get("MOMO_DATA_DIR")
    or (Path(__file__).resolve().parent.parent.parent / "data")
)
STATE_PATH = DATA_DIR / "momo.yaml"

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
        },
        "llm": {"url": "", "key": "", "model": ""},
        "asr": {"url": "", "key": ""},
        "tts": {"url": "", "key": "", "voice": ""},
        # 语义检索端点（设置页「模型」tab 可改）。
        # url 留空 = 未配置语义检索，只用词面召回；env（MOMO_EMBEDDING_*）可覆盖。
        # model 不预填：DEFAULT_EMBEDDING_MODEL 只作「填了 url 却没填 model」时的
        # 内部兜底（见 core/embed.py），不作为出厂配置展示给用户。
        "embedding": {
            "url": DEFAULT_EMBEDDING_URL,
            "key": "",
            "model": "",
        },
        # MCP 拓展清单（{name,transport,enabled} + stdio{command,args,env} / http{endpoint,headers}）
        "extensions": [],
    },
    "avatars": [_BUILTIN_AVATAR],
    "avatarId": "builtin",
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


def normalize_state(state: dict[str, Any] | None) -> State:
    """任意（可能残缺）state → 合并默认值后的完整 state。

    这是**形状保证边界**：返回值的字段必然齐全，因此下游消费方
    （services/turn、services/compress、memory、services/prompt）直接下标访问即可，
    不需要 `(state.get("settings") or {}).get(...) or {}` 那层防御。
    """
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


def load() -> State:
    """读取 + 归一化，进程内消费配置的统一入口。

    返回值字段必然齐全（见 normalize_state），因此 service 层直接下标访问即可。
    """
    return normalize_state(read_state())


def read_state() -> dict[str, Any] | None:
    """读原始 state；文件不存在或 YAML 损坏返回 None。"""
    try:
        data = yaml.safe_load(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def write_state(state: dict[str, Any]) -> None:
    """整体写入 momo.yaml（不做归一化，读取时再合并默认值）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(
        yaml.safe_dump(state, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )


def get_state() -> dict[str, Any]:
    """GET /api/state 用：无文件返回 {}，否则返回归一化后的完整 state。"""
    raw = read_state()
    if raw is None:
        return {}
    return normalize_state(raw)
