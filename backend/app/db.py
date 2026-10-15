"""data/momo.db：数据层（memories / memory_vec / sessions / messages）。

- 单连接（check_same_thread=False）+ RLock；写路径统一走 tx()
  （BEGIN IMMEDIATE），回合落盘 / 读档 / 后台压缩在 DB 层互斥。
- sessions.id='live' 是当前会话行：messages 追加其下；generation
  在 load 时 +1，回合落账校验代际——读档/打断让在途回合的写入作废。
- memory_vec 是 sqlite-vec vec0 虚拟表（cosine KNN，id 关联 memories）。
  扩展加载失败或维度与当前 embedding 不符时自动降级/重建，
  召回退回 bigram Jaccard——记忆读写本身不依赖向量。
"""
from __future__ import annotations

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
