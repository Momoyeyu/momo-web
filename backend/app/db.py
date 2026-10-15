"""data/momo.db：数据层（memories / memory_vec / sessions / messages）。

- 单连接（check_same_thread=False）+ RLock；写路径统一走 tx()
  （BEGIN IMMEDIATE），回合落盘 / 读档 / 后台压缩在 DB 层互斥。
- sessions.id='live' 是当前会话行：messages 追加其下；generation
  在 load 时 +1，回合落账校验代际——读档/打断让在途回合的写入作废。
- memory_vec 是 sqlite-vec vec0 虚拟表（cosine KNN，id 关联 memories）。
  扩展加载失败或维度与当前 embedding 不符时自动降级/重建，
  召回退回 bigram Jaccard——记忆读写本身不依赖向量。
- migrate_legacy()：首启把旧 JSON（memories/memory-embeddings/
  checkpoints/sessions.json + state.json 的 pins/history/summary）
  一次性导入，随后旧文件停用（不删除）。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from . import store

LIVE_ID = "live"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(n: int = 12) -> str:
    return uuid.uuid4().hex[:n]

_conn: sqlite3.Connection | None = None
_lock = threading.RLock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories(
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY,
    slot INTEGER,
    auto INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages(
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (session_id, seq)
);
"""

try:
    import sqlite_vec
except Exception:  # pragma: no cover - 扩展缺失时降级词面召回
    sqlite_vec = None  # type: ignore[assignment]


def _db_path():
    return store.DATA_DIR / "momo.db"


def conn() -> sqlite3.Connection:
    """进程级单连接（懒建 + schema 保证）。测试改 DATA_DIR 后调 reset()。"""
    global _conn
    with _lock:
        if _conn is None:
            _db_path().parent.mkdir(parents=True, exist_ok=True)
            c = sqlite3.connect(str(_db_path()), check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys = ON")
            c.execute("PRAGMA journal_mode = WAL")
            if sqlite_vec is not None:
                try:
                    c.enable_load_extension(True)
                    sqlite_vec.load(c)
                except Exception:
                    pass  # vec 不可用时 ensure_vec 会失败 → 词面召回
            c.executescript(_SCHEMA)
            _ensure_live(c)
            c.commit()
            _conn = c
        return _conn


def reset() -> None:
    """关掉当前连接（测试隔离用：改 DATA_DIR 后重开）。"""
    global _conn
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """写事务：BEGIN IMMEDIATE + 锁内提交/回滚（读-改-写原子）。"""
    c = conn()
    with _lock:
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise


def query(sql: str, params: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return conn().execute(sql, params).fetchall()


def meta_get(key: str, default: str = "") -> str:
    rows = query("SELECT value FROM meta WHERE key=?", (key,))
    return str(rows[0]["value"]) if rows else default


def meta_set(key: str, value: str) -> None:
    with tx() as c:
        c.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def _ensure_live(c: sqlite3.Connection) -> None:
    """当前会话行恒存在（其余列取默认）。"""
    c.execute(
        "INSERT OR IGNORE INTO sessions(id, slot, auto, created_at, updated_at)"
        " VALUES(?, NULL, 0, ?, ?)",
        (LIVE_ID, _now_iso(), _now_iso()),
    )


# ---------- memory_vec（维度跟随当前 embedding 输出） ----------


def _vec_table_dim() -> int | None:
    """已建 vec 表的向量维度；未建返回 None。"""
    dim = meta_get("vec_dim")
    try:
        return int(dim) if dim else None
    except ValueError:
        return None


def ensure_vec(dim: int) -> bool:
    """保证 memory_vec 存在且维度=dim；维度漂移 → 重建（向量可懒算补回）。"""
    if sqlite_vec is None or dim <= 0:
        return False
    with tx() as c:
        cur = _vec_table_dim()
        exists = c.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vec'"
        ).fetchone()
        if exists and cur == dim:
            return True
        c.execute("DROP TABLE IF EXISTS memory_vec")
        c.execute(
            f"CREATE VIRTUAL TABLE memory_vec USING vec0("
            f"id TEXT PRIMARY KEY, vec float[{int(dim)}] distance_metric=cosine)"
        )
        c.execute(
            "INSERT INTO meta(key,value) VALUES('vec_dim',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(dim),),
        )
    return True


def vec_available() -> bool:
    return _vec_table_dim() is not None


# ---------- 旧 JSON → DB 一次性导入 ----------


def migrate_legacy() -> None:
    """旧存储一次性导入（meta.imported=1 幂等）；导入后剥离 state.json 中已迁键。"""
    data = store.DATA_DIR
    with tx() as c:
        if meta_get("imported") == "1":
            return

        # 1) state.json：pins→memories(pinned=1)，history→live messages，summary→live
        raw = store.read_state() or {}
        existing = {
            r["content"]
            for r in c.execute("SELECT content FROM memories").fetchall()
        }
        for p in raw.get("pins") or []:
            if isinstance(p, str) and p.strip() and p.strip() not in existing:
                c.execute(
                    "INSERT INTO memories(id,content,created_at,pinned)"
                    " VALUES(?,?,?,1)",
                    (_new_id(), p.strip(), _now_iso()),
                )
                existing.add(p.strip())
        history = [m for m in (raw.get("history") or []) if isinstance(m, dict)]
        if history:
            for i, m in enumerate(history):
                if m.get("role") not in ("user", "assistant"):
                    continue
                c.execute(
                    "INSERT INTO messages(session_id,seq,role,text,at)"
                    " VALUES(?,?,?,?,?)",
                    (
                        LIVE_ID,
                        i,
                        m["role"],
                        str(m.get("text") or ""),
                        str(m.get("at") or ""),
                    ),
                )
        summary = str(raw.get("summary") or "")
        if summary:
            c.execute(
                "UPDATE sessions SET summary=? WHERE id=?", (summary, LIVE_ID)
            )

        # 2) memories.json → memories(pinned=0)
        mem_path = data / "memories.json"
        if mem_path.exists():
            try:
                mems = json.loads(mem_path.read_text(encoding="utf-8"))
            except Exception:
                mems = []
            if isinstance(mems, list):
                for m in mems:
                    if not isinstance(m, dict):
                        continue
                    content = str(m.get("content") or "").strip()
                    if not content or content in existing:
                        continue
                    mid = str(m.get("id") or "") or _new_id()
                    c.execute(
                        "INSERT OR IGNORE INTO"
                        " memories(id,content,created_at,pinned) VALUES(?,?,?,0)",
                        (mid, content, str(m.get("createdAt") or _now_iso())),
                    )
                    existing.add(content)

        # 3) memory-embeddings.json：sha256(content)→vec，按记忆 id 落 vec 表
        emb_path = data / "memory-embeddings.json"
        if emb_path.exists() and sqlite_vec is not None:
            try:
                cache = json.loads(emb_path.read_text(encoding="utf-8"))
            except Exception:
                cache = {}
            if isinstance(cache, dict):
                rows = c.execute("SELECT id, content FROM memories").fetchall()
                dim = 0
                pending: list[tuple[str, list[float]]] = []
                for r in rows:
                    h = hashlib.sha256(r["content"].encode("utf-8")).hexdigest()
                    vec = cache.get(h)
                    if isinstance(vec, list) and vec:
                        pending.append((r["id"], [float(x) for x in vec]))
                        dim = dim or len(vec)
                if dim:
                    c.execute("DROP TABLE IF EXISTS memory_vec")
                    c.execute(
                        "CREATE VIRTUAL TABLE memory_vec USING vec0("
                        f"id TEXT PRIMARY KEY, vec float[{dim}]"
                        " distance_metric=cosine)"
                    )
                    c.execute(
                        "INSERT INTO meta(key,value) VALUES('vec_dim',?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (str(dim),),
                    )
                    for mid, vec in pending:
                        if len(vec) == dim:
                            c.execute(
                                "INSERT OR REPLACE INTO memory_vec(id,vec)"
                                " VALUES(?,?)",
                                (mid, json.dumps(vec)),
                            )

        # 4) checkpoints.json（旧 sessions.json 回退）→ sessions+messages
        for name in ("checkpoints.json", "sessions.json"):
            cp_path = data / name
            if not cp_path.exists():
                continue
            try:
                saves = json.loads(cp_path.read_text(encoding="utf-8"))
            except Exception:
                saves = []
            if isinstance(saves, list):
                # 旧数据无 slot 字段的手动档按文件序补最小编号空槽
                used_slots = {
                    int(s["slot"])
                    for s in saves
                    if isinstance(s, dict)
                    and not s.get("auto")
                    and isinstance(s.get("slot"), int)
                    and 1 <= int(s["slot"]) <= 120
                }
                next_slot = 1
                for s in saves:
                    if not isinstance(s, dict):
                        continue
                    sid = str(s.get("id") or "") or _new_id(8)
                    slot = s.get("slot")
                    if s.get("auto"):
                        slot = None
                    elif not (
                        isinstance(slot, int) and 1 <= slot <= 120
                    ):
                        while next_slot in used_slots:
                            next_slot += 1
                        slot = next_slot
                        used_slots.add(slot)
                    c.execute(
                        "INSERT OR IGNORE INTO sessions"
                        "(id,slot,auto,title,summary,created_at,updated_at)"
                        " VALUES(?,?,?,?,?,?,?)",
                        (
                            sid,
                            slot,
                            1 if s.get("auto") else 0,
                            str(s.get("title") or ""),
                            str(s.get("summary") or ""),
                            str(s.get("createdAt") or _now_iso()),
                            str(s.get("updatedAt") or _now_iso()),
                        ),
                    )
                    for i, m in enumerate(s.get("messages") or []):
                        if not isinstance(m, dict):
                            continue
                        if m.get("role") not in ("user", "assistant"):
                            continue
                        c.execute(
                            "INSERT INTO messages(session_id,seq,role,text,at)"
                            " VALUES(?,?,?,?,?)",
                            (
                                sid,
                                i,
                                m["role"],
                                str(m.get("text") or ""),
                                str(m.get("at") or ""),
                            ),
                        )
            break  # 两个名字只取先命中的那个

        c.execute(
            "INSERT INTO meta(key,value) VALUES('imported','1') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )

    # 已迁键从 state.json 剥离（一次写回，之后 backend 不再读它们）
    if isinstance(raw, dict) and raw:
        stripped = {
            k: v
            for k, v in raw.items()
            if k not in ("pins", "history", "summary", "memories", "user")
        }
        if stripped != raw:
            store.write_state(stripped)
