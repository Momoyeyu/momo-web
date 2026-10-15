"""会话存档：data/sessions.json 槽位制 Save/Load。

- 条目 schema：{id(8位hex), title, auto, createdAt, updatedAt, summary, messages[]}
- 当前会话仍在 state.json（history + summary）；存档 = 某时刻的快照副本。
- auto=True 是「自动存档」专用槽：load 前当前会话非空时写入，
  重复 load 覆盖同一槽（不占手动槽位）。
- 写回 state 走 store.update_state 锁内 read-modify-write，
  与回合落盘/后台压缩互斥，不丢在途追加。
"""
from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from . import store
from .store import DATA_DIR

SESSIONS_PATH = DATA_DIR / "sessions.json"
PREVIEW_LEN = 40


class SessionError(Exception):
    """存档操作失败。kind: not_found（404）/ invalid（400）。"""

    def __init__(self, message: str, kind: str = "invalid") -> None:
        super().__init__(message)
        self.kind = kind
        self.not_found = kind == "not_found"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_title() -> str:
    """默认存档名 = 本地时间（如 2025-01-02 15:04）。"""
    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")


def _new_id() -> str:
    return uuid.uuid4().hex[:8]


# ---------- 文件读写 ----------

def _load() -> list[dict[str, Any]]:
    try:
        data = json.loads(SESSIONS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []
    return [s for s in data if isinstance(s, dict)] if isinstance(data, list) else []


def _save(saves: list[dict[str, Any]]) -> None:
    SESSIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_PATH.write_text(
        json.dumps(saves, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ---------- 快照 / 展示 ----------

def _clean_messages(history: Any) -> list[dict[str, str]]:
    """history → 存档 messages：只留 user/assistant 的 {role,text,at}。"""
    out: list[dict[str, str]] = []
    for m in history or []:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        out.append(
            {
                "role": m["role"],
                "text": str(m.get("text") or ""),
                "at": str(m.get("at") or ""),
            }
        )
    return out


def _snapshot() -> tuple[str, list[dict[str, str]]]:
    """当前会话快照：state.summary + history（指令剥离后的干净文本）。"""
    state = store.normalize_state(store.read_state())
    return str(state.get("summary") or ""), _clean_messages(state.get("history"))


def _preview(messages: Any) -> str:
    """列表预览：首条消息文本压空白后截 ~40 字。"""
    if isinstance(messages, list) and messages:
        first = messages[0]
        if isinstance(first, dict):
            text = " ".join(str(first.get("text") or "").split())
            return text[:PREVIEW_LEN]
    return ""


def meta(entry: dict[str, Any]) -> dict[str, Any]:
    """列表项（不含完整 messages）。"""
    return {
        "id": str(entry.get("id") or ""),
        "title": str(entry.get("title") or ""),
        "auto": bool(entry.get("auto")),
        "createdAt": str(entry.get("createdAt") or ""),
        "updatedAt": str(entry.get("updatedAt") or ""),
        "preview": _preview(entry.get("messages")),
    }


# ---------- CRUD ----------

def list_sessions() -> list[dict[str, Any]]:
    return [meta(s) for s in _load()]


def _find(saves: list[dict[str, Any]], sid: str) -> dict[str, Any] | None:
    return next((s for s in saves if s.get("id") == sid), None)


def get_session(sid: str) -> dict[str, Any]:
    entry = _find(_load(), sid)
    if entry is None:
        raise SessionError("存档不存在", kind="not_found")
    return entry


def create_session(title: str | None = None) -> dict[str, Any]:
    """快照当前会话新建存档；title 空 → 默认当前时间。"""
    summary, messages = _snapshot()
    now = _now_iso()
    entry = {
        "id": _new_id(),
        "title": (title or "").strip() or _default_title(),
        "auto": False,
        "createdAt": now,
        "updatedAt": now,
        "summary": summary,
        "messages": messages,
    }
    saves = _load()
    saves.append(entry)
    _save(saves)
    return entry


def overwrite_session(sid: str, title: str | None = None) -> dict[str, Any]:
    """重命名（title 非空时）+ 用当前会话内容覆盖。"""
    summary, messages = _snapshot()
    saves = _load()
    entry = _find(saves, sid)
    if entry is None:
        raise SessionError("存档不存在", kind="not_found")
    if title and title.strip():
        entry["title"] = title.strip()
    entry["summary"] = summary
    entry["messages"] = messages
    entry["updatedAt"] = _now_iso()
    _save(saves)
    return entry


def delete_session(sid: str) -> dict[str, Any]:
    saves = _load()
    for i, s in enumerate(saves):
        if s.get("id") == sid:
            gone = saves.pop(i)
            _save(saves)
            return gone
    raise SessionError("存档不存在", kind="not_found")


# ---------- Load ----------

def _write_auto(summary: str, messages: list[dict[str, str]]) -> None:
    """当前会话写入自动存档槽：已有 auto 槽原地覆盖，否则插到首位。"""
    saves = _load()
    for s in saves:
        if s.get("auto"):
            s["summary"] = summary
            s["messages"] = messages
            s["updatedAt"] = _now_iso()
            _save(saves)
            return
    now = _now_iso()
    saves.insert(
        0,
        {
            "id": _new_id(),
            "title": _default_title(),
            "auto": True,
            "createdAt": now,
            "updatedAt": now,
            "summary": summary,
            "messages": messages,
        },
    )
    _save(saves)


def load_session(sid: str) -> dict[str, Any]:
    """加载存档覆盖当前会话；当前会话非空先存入 auto 槽。返回存档全文。"""
    target = _find(_load(), sid)
    if target is None:
        raise SessionError("存档不存在", kind="not_found")

    def _mutate(state: dict[str, Any]) -> None:
        cur_summary = str(state.get("summary") or "")
        cur_messages = _clean_messages(state.get("history"))
        if cur_messages:
            _write_auto(cur_summary, cur_messages)
        state["summary"] = str(target.get("summary") or "")
        state["history"] = copy.deepcopy(target.get("messages") or [])

    store.update_state(_mutate)
    return target
