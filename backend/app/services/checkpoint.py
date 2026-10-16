"""会话存档 checkpoint：data/momo.db 的 sessions/messages 表。

- 当前会话 = sessions 中固定活跃行 id='live'，回合随落账实时追加 messages；
  存档 = 快照行（slots 1..120 手动槽 / auto=1 自动档不占号）。
- Save：live → 复制为新快照行 + 复制 messages；Load：live 先自动快照
  （写入 auto 槽），目标快照灌回 live。
- live.generation：load / interrupt 时 +1。回合在开始时记下代际，
  assistant 落账时校验——读档或打断使在途回合的写入作废。
- 全部读写走 db.tx() / db.query()，并发安全由单连接 + BEGIN IMMEDIATE 保证。
"""
from __future__ import annotations

import sqlite3
from typing import Any

from ..core import db
from ..models import CheckpointDetail, CheckpointMeta, StoredMessage

PREVIEW_LEN = 40
MAX_SLOT = 120  # 手动存档槽位上限（12 格/页 × 10 页）
LIVE_HISTORY_MAX = 100  # live 会话行消息数上限（超出截尾，边界不拆回合）
LIVE_ID = db.LIVE_ID


class CheckpointError(Exception):
    """存档操作失败。kind: not_found（404）/ invalid（400）/ conflict（409）。"""

    def __init__(self, message: str, kind: str = "invalid") -> None:
        super().__init__(message)
        self.kind = kind
        self.not_found = kind == "not_found"


now_iso = db.now_iso


def _default_title() -> str:
    """默认存档名 = 本地时间（如 2025-01-02 15:04）。"""
    from datetime import datetime

    return datetime.now().astimezone().strftime("%Y-%m-%d %H:%M")


def _new_id() -> str:
    return db.new_id(8)


# ---------- live 会话（当前会话行） ----------

def live_summary() -> str:
    rows = db.query("SELECT summary FROM sessions WHERE id=?", (LIVE_ID,))
    return str(rows[0]["summary"]) if rows else ""


def live_messages() -> list[StoredMessage]:
    """当前会话消息（展示/注入上下文用；不含 role 外的内部列）。"""
    rows = db.query(
        "SELECT role, text, at FROM messages WHERE session_id=? ORDER BY seq",
        (LIVE_ID,),
    )
    return [
        {"role": r["role"], "text": r["text"], "at": r["at"]} for r in rows
    ]


def generation() -> int:
    rows = db.query("SELECT generation FROM sessions WHERE id=?", (LIVE_ID,))
    return int(rows[0]["generation"]) if rows else 0


def _next_seq(c: sqlite3.Connection, sid: str) -> int:
    r = c.execute(
        "SELECT COALESCE(MAX(seq)+1, 0) AS s FROM messages WHERE session_id=?",
        (sid,),
    ).fetchone()
    return int(r["s"])


def begin_turn(text: str, gen: int, at: str) -> bool:
    """回合开始：代际仍有效时把 user 消息追加进 live。

    False = 代际已变（期间发生 load/interrupt），在途回合作废。
    """
    with db.tx() as c:
        cur = c.execute(
            "SELECT generation FROM sessions WHERE id=?", (LIVE_ID,)
        ).fetchone()
        if cur is None or int(cur["generation"]) != gen:
            return False
        c.execute(
            "INSERT INTO messages(session_id,seq,role,text,at) VALUES(?,?,?,?,?)",
            (LIVE_ID, _next_seq(c, LIVE_ID), "user", text, at),
        )
        c.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?", (at, LIVE_ID)
        )
        return True


def append_sentence(text: str, gen: int, at: str) -> bool:
    """assistant 单句落账：代际一致才写入；读档/打断后 gen 漂移 → 丢弃。

    一次回复会调用 N 次（一回合 N 句，DB 里就是 N 行 assistant）。回合边界由
    其后的 user 行界定，因此不需要额外的 turn_id 列：合并回放、裁剪、打断
    都可以由「user 行 = 回合起点」这条规则推出（见 turn._merge_assistant）。

    写入成功后同事务内裁剪 live.messages 至上限。
    """
    with db.tx() as c:
        cur = c.execute(
            "SELECT generation FROM sessions WHERE id=?", (LIVE_ID,)
        ).fetchone()
        if cur is None or int(cur["generation"]) != gen:
            return False
        c.execute(
            "INSERT INTO messages(session_id,seq,role,text,at) VALUES(?,?,?,?,?)",
            (LIVE_ID, _next_seq(c, LIVE_ID), "assistant", text, at),
        )
        c.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?", (at, LIVE_ID)
        )
        _trim_live(c)
        return True


def _trim_live(c: sqlite3.Connection) -> None:
    """live.messages 保留最新 LIVE_HISTORY_MAX 条，删除更旧的。

    裁剪边界不拆散完整回合：剩余的最早一条必须是 role='user'——
    切在 assistant 上则向前回退到最近的 user 边界（多留若干条）。
    """
    rows = c.execute(
        "SELECT seq, role FROM messages WHERE session_id=? ORDER BY seq",
        (LIVE_ID,),
    ).fetchall()
    if len(rows) <= LIVE_HISTORY_MAX:
        return
    cut = len(rows) - LIVE_HISTORY_MAX
    while cut > 0 and rows[cut]["role"] != "user":
        cut -= 1
    c.execute(
        "DELETE FROM messages WHERE session_id=? AND seq<?",
        (LIVE_ID, rows[cut]["seq"]),
    )


def interrupt_turn(user: str, assistant: str) -> None:
    """打断落账调和：代际 +1（在途回合的落账作废），并把 live 尾对
    （user,assistant）修正为「用户实际看到的」状态：

    - 回复已落账（末对就是本回合）→ 截断/删除 assistant 行
    - user 已落账、回复未落账（打断发生在生成中）→ 补写已展示部分（空则不写）
    - 尾对不匹配（回合没到 backend）→ 直接补写整个结果

    幂等：重复打断同一回合不会重复写 user 行。
    """
    user = str(user or "")
    assistant = str(assistant or "")
    with db.tx() as c:
        c.execute(
            "UPDATE sessions SET generation=generation+1 WHERE id=?", (LIVE_ID,)
        )
        rows = c.execute(
            "SELECT rowid, role, text FROM messages WHERE session_id=?"
            " ORDER BY seq DESC LIMIT 2",
            (LIVE_ID,),
        ).fetchall()
        last = rows[0] if rows else None
        prev = rows[1] if len(rows) > 1 else None
        now = now_iso()
        if (
            last
            and last["role"] == "assistant"
            and prev
            and prev["role"] == "user"
            and prev["text"] == user
        ):
            # 已落账的完整回复：截到已展示文本（空 = 用户一个字没看到 → 删行）
            if assistant:
                c.execute(
                    "UPDATE messages SET text=? WHERE rowid=?",
                    (assistant, last["rowid"]),
                )
            else:
                c.execute("DELETE FROM messages WHERE rowid=?", (last["rowid"],))
        elif last and last["role"] == "user" and last["text"] == user:
            if assistant:
                c.execute(
                    "INSERT INTO messages(session_id,seq,role,text,at)"
                    " VALUES(?,?,?,?,?)",
                    (LIVE_ID, _next_seq(c, LIVE_ID), "assistant", assistant, now),
                )
        else:
            # 回合没走到 backend（SSE 没到就被打断）：把结果补成一致
            if user:
                seq = _next_seq(c, LIVE_ID)
                c.execute(
                    "INSERT INTO messages(session_id,seq,role,text,at)"
                    " VALUES(?,?,?,?,?)",
                    (LIVE_ID, seq, "user", user, now),
                )
                if assistant:
                    c.execute(
                        "INSERT INTO messages(session_id,seq,role,text,at)"
                        " VALUES(?,?,?,?,?)",
                        (LIVE_ID, seq + 1, "assistant", assistant, now),
                    )
        c.execute(
            "UPDATE sessions SET updated_at=? WHERE id=?", (now, LIVE_ID)
        )


# ---------- 快照 / 展示 ----------

def _messages_of(c: sqlite3.Connection, sid: str) -> list[StoredMessage]:
    rows = c.execute(
        "SELECT role, text, at FROM messages WHERE session_id=? ORDER BY seq",
        (sid,),
    ).fetchall()
    return [
        {"role": r["role"], "text": r["text"], "at": r["at"]} for r in rows
    ]


def _copy_messages(c: sqlite3.Connection, src: str, dst: str) -> None:
    """整段复制 src 会话的 messages 到 dst（dst 原有先清）。"""
    c.execute("DELETE FROM messages WHERE session_id=?", (dst,))
    c.execute(
        "INSERT INTO messages(session_id,seq,role,text,at)"
        " SELECT ?, seq, role, text, at FROM messages"
        " WHERE session_id=? ORDER BY seq",
        (dst, src),
    )


def _preview_of(c: sqlite3.Connection, sid: str) -> str:
    """列表预览：末条消息文本压空白后截 ~40 字（最新一句对话）。"""
    r = c.execute(
        "SELECT text FROM messages WHERE session_id=?"
        " ORDER BY seq DESC LIMIT 1",
        (sid,),
    ).fetchone()
    if r is None:
        return ""
    return " ".join(str(r["text"]).split())[:PREVIEW_LEN]


def _meta_row(r: sqlite3.Row, preview: str) -> CheckpointMeta:
    slot = r["slot"]
    return {
        "id": r["id"],
        "title": r["title"],
        "auto": bool(r["auto"]),
        "slot": int(slot) if slot is not None else None,
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
        "preview": preview,
    }


def meta(entry: CheckpointDetail) -> CheckpointMeta:
    """存档全文 → 列表项（丢 messages，用末条算出 preview）。"""
    msgs = entry.get("messages")
    if isinstance(msgs, list) and msgs:
        last = msgs[-1]
        text = (
            " ".join(str(last.get("text") or "").split())[:PREVIEW_LEN]
            if isinstance(last, dict)
            else ""
        )
    else:
        text = ""
    return {
        "id": str(entry.get("id") or ""),
        "title": str(entry.get("title") or ""),
        "auto": bool(entry.get("auto")),
        "slot": entry.get("slot"),
        "createdAt": str(entry.get("createdAt") or ""),
        "updatedAt": str(entry.get("updatedAt") or ""),
        "preview": text,
    }


def _entry(c: sqlite3.Connection, r: sqlite3.Row) -> CheckpointDetail:
    """会话行 → 存档全文 dict（含 messages）。"""
    m = _meta_row(r, _preview_of(c, r["id"]))
    return {
        "id": m["id"],
        "title": m["title"],
        "auto": m["auto"],
        "slot": m["slot"],
        "createdAt": m["createdAt"],
        "updatedAt": m["updatedAt"],
        "summary": r["summary"],
        "messages": _messages_of(c, r["id"]),
    }


# ---------- CRUD ----------

def list_checkpoints() -> list[CheckpointMeta]:
    """auto 槽置顶，其后手动存档按 slot 升序（不含 live 行）。"""
    with db.tx() as c:
        rows = c.execute(
            "SELECT * FROM sessions WHERE id != ?"
            " ORDER BY auto DESC, slot ASC",
            (LIVE_ID,),
        ).fetchall()
        return [_meta_row(r, _preview_of(c, r["id"])) for r in rows]


def get_checkpoint(sid: str) -> CheckpointDetail:
    if sid == LIVE_ID:
        raise CheckpointError("存档不存在", kind="not_found")
    with db.tx() as c:
        r = c.execute(
            "SELECT * FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if r is None:
            raise CheckpointError("存档不存在", kind="not_found")
        return _entry(c, r)


def _assign_slot(c: sqlite3.Connection, slot: Any) -> int:
    """确定新存档槽位：指定空槽则用之，未指定取最小编号空槽。"""
    used = {
        int(r["slot"])
        for r in c.execute(
            "SELECT slot FROM sessions WHERE auto=0 AND slot IS NOT NULL"
            " AND id != ?",
            (LIVE_ID,),
        ).fetchall()
    }
    if slot is None:
        for n in range(1, MAX_SLOT + 1):
            if n not in used:
                return n
        raise CheckpointError(f"手动存档已满（{MAX_SLOT} 槽）", kind="conflict")
    if not (isinstance(slot, int) and not isinstance(slot, bool) and 1 <= slot <= MAX_SLOT):
        raise CheckpointError(f"槽位号需在 1–{MAX_SLOT} 之间")
    if slot in used:
        raise CheckpointError(f"槽位 {slot} 已被占用", kind="conflict")
    return int(slot)


def create_checkpoint(
    title: str | None = None, slot: int | None = None
) -> CheckpointDetail:
    """快照当前会话新建存档；title 空 → 默认当前时间；slot 空 → 最小空槽。"""
    with db.tx() as c:
        sslot = _assign_slot(c, slot)
        now = now_iso()
        sid = _new_id()
        c.execute(
            "INSERT INTO sessions"
            "(id,slot,auto,title,summary,created_at,updated_at) VALUES(?,?,0,?,?,?,?)",
            (
                sid,
                sslot,
                (title or "").strip() or _default_title(),
                live_summary(),
                now,
                now,
            ),
        )
        _copy_messages(c, LIVE_ID, sid)
        return _entry(c, c.execute(
            "SELECT * FROM sessions WHERE id=?", (sid,)
        ).fetchone())


def overwrite_checkpoint(sid: str, title: str | None = None) -> CheckpointDetail:
    """重命名（title 非空时）+ 用当前会话内容覆盖。"""
    _guard_snapshot_id(sid)
    with db.tx() as c:
        r = c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        if r is None:
            raise CheckpointError("存档不存在", kind="not_found")
        if r["auto"]:
            raise CheckpointError("自动存档槽不可覆盖", kind="invalid")
        now = now_iso()
        t = (title or "").strip()
        c.execute(
            "UPDATE sessions SET summary=?, updated_at=?"
            + (", title=?" if t else "")
            + " WHERE id=?",
            (live_summary(), now, t, sid) if t else (live_summary(), now, sid),
        )
        _copy_messages(c, LIVE_ID, sid)
        return _entry(c, c.execute(
            "SELECT * FROM sessions WHERE id=?", (sid,)
        ).fetchone())


def delete_checkpoint(sid: str) -> CheckpointDetail:
    _guard_snapshot_id(sid)
    with db.tx() as c:
        r = c.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        if r is None:
            raise CheckpointError("存档不存在", kind="not_found")
        if r["auto"]:
            raise CheckpointError("自动存档槽不可删除", kind="invalid")
        entry = _entry(c, r)
        c.execute("DELETE FROM sessions WHERE id=?", (sid,))
        return entry


def _guard_snapshot_id(sid: str) -> None:
    if sid == LIVE_ID:
        raise CheckpointError("存档不存在", kind="not_found")


# ---------- Load ----------


def _write_auto(c: sqlite3.Connection, summary: str) -> None:
    """当前 live 内容写入 auto 槽：已有 auto 槽原地覆盖，否则新建。"""
    now = now_iso()
    row = c.execute(
        "SELECT id FROM sessions WHERE auto=1 AND id != ?", (LIVE_ID,)
    ).fetchone()
    if row is None:
        aid = _new_id()
        c.execute(
            "INSERT INTO sessions"
            "(id,slot,auto,title,summary,created_at,updated_at)"
            " VALUES(?,NULL,1,?,?,?,?)",
            (aid, _default_title(), summary, now, now),
        )
    else:
        aid = row["id"]
        c.execute(
            "UPDATE sessions SET summary=?, updated_at=? WHERE id=?",
            (summary, now, aid),
        )
    _copy_messages(c, LIVE_ID, aid)


def load_checkpoint(sid: str) -> CheckpointDetail:
    """加载存档覆盖当前会话；当前会话非空先存入 auto 槽。返回存档全文。

    代际 +1：load 之后在途回合的 append_sentence 全部作废（其 user
    行已随原 live 进 auto 槽）。
    """
    _guard_snapshot_id(sid)
    with db.tx() as c:
        target = c.execute(
            "SELECT * FROM sessions WHERE id=?", (sid,)
        ).fetchone()
        if target is None:
            raise CheckpointError("存档不存在", kind="not_found")
        cur_summary = ""
        cur_count = 0
        live = c.execute(
            "SELECT summary FROM sessions WHERE id=?", (LIVE_ID,)
        ).fetchone()
        if live is not None:
            cur_summary = str(live["summary"] or "")
            cur_count = int(
                c.execute(
                    "SELECT COUNT(*) AS n FROM messages WHERE session_id=?",
                    (LIVE_ID,),
                ).fetchone()["n"]
            )
        if cur_count:
            _write_auto(c, cur_summary)
        _copy_messages(c, sid, LIVE_ID)
        now = now_iso()
        c.execute(
            "UPDATE sessions SET summary=?, updated_at=?,"
            " generation=generation+1 WHERE id=?",
            (str(target["summary"] or ""), now, LIVE_ID),
        )
        return _entry(c, target)


def new_session() -> None:
    """开启新会话：live 非空先快照进 auto 槽，然后清空 live。

    代际 +1：在途回合的 append_sentence 全部作废（其 user 行已随原
    live 进 auto 槽）。
    """
    with db.tx() as c:
        live = c.execute(
            "SELECT summary FROM sessions WHERE id=?", (LIVE_ID,)
        ).fetchone()
        if live is not None:
            n = c.execute(
                "SELECT COUNT(*) AS n FROM messages WHERE session_id=?",
                (LIVE_ID,),
            ).fetchone()["n"]
            if n:
                _write_auto(c, str(live["summary"] or ""))
        c.execute("DELETE FROM messages WHERE session_id=?", (LIVE_ID,))
        c.execute(
            "UPDATE sessions SET summary='', updated_at=?,"
            " generation=generation+1 WHERE id=?",
            (now_iso(), LIVE_ID),
        )
