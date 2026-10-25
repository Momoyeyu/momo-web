"""data/momo.yaml 读写与默认值归一化。

momo.yaml 是配置层持久化（gitignored）。读取时做 defaults 深合并：
缺失键补默认值，多余键原样透传（前端字段后端不消费的也保留）。
"""
from __future__ import annotations

import copy
import os
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

if TYPE_CHECKING:
    from ..models import State


# 数据目录（momo.db + momo.yaml）。env 可覆盖——用于测试隔离与多实例共存，
# 免得跑集成测试时写坏真实配置。
DATA_DIR = Path(
    os.environ.get("MOMO_DATA_DIR")
    or (Path(__file__).resolve().parent.parent.parent / "data")
)
STATE_PATH = DATA_DIR / "momo.yaml"

# 内置形象仅占位；实际资源与语义由前端加载、校准并随请求提供。
_BUILTIN_AVATAR: dict[str, Any] = {
    "id": "builtin",
    "builtin": True,
    "name": "Hiyori",
    "fileName": "",
    "manifest": "Hiyori.model3.json",
    "size": 0,
    "addedAt": "",
    "resources": {"expressions": [], "motions": []},
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
        "llm": {"url": "", "key": "", "model": "", "thinking": False},
        "tts": {"url": "", "key": "", "voice": "", "prompt": ""},
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


def _retire_remote_services(state: dict[str, Any]) -> dict[str, Any]:
    """Retire ASR/embedding endpoints and credentials without mutating callers."""
    clean = copy.deepcopy(state) if isinstance(state, dict) else {}
    settings = clean.get("settings")
    if isinstance(settings, dict):
        settings.pop("asr", None)
        settings.pop("embedding", None)
    return clean


def normalize_state(state: dict[str, Any] | None) -> State:
    """任意（可能残缺）state → 合并默认值后的完整 state。

    这是**形状保证边界**：返回值的字段必然齐全，因此下游消费方
    （services/turn、services/compress、memory、services/prompt）直接下标访问即可，
    不需要 `(state.get("settings") or {}).get(...) or {}` 那层防御。
    """
    merged = _merge(DEFAULT_STATE, _retire_remote_services(state or {}))
    settings = merged.get("settings")
    if not isinstance(settings, dict):
        settings = merged["settings"] = copy.deepcopy(DEFAULT_STATE["settings"])
    if not isinstance(settings.get("llm"), dict):
        settings["llm"] = copy.deepcopy(DEFAULT_STATE["settings"]["llm"])
    settings["llm"]["thinking"] = settings["llm"].get("thinking") is True
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
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=DATA_DIR,
                                         prefix=".momo-", suffix=".yaml", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(yaml.safe_dump(_retire_remote_services(state), allow_unicode=True, sort_keys=False))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, STATE_PATH)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def retire_legacy_services() -> bool:
    """One-time startup cleanup of retired credentials from an existing config."""
    raw = read_state()
    if raw is None:
        return False
    clean = _retire_remote_services(raw)
    if clean == raw:
        return False
    write_state(clean)
    return True


def get_state() -> dict[str, Any]:
    """GET /api/state 用：无文件返回 {}，否则返回归一化后的完整 state。"""
    raw = read_state()
    if raw is None:
        return {}
    return normalize_state(raw)
