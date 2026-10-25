"""data/momo.db：连接、schema、事务（存储层的公共底座）。

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
import os
import tempfile
from pathlib import Path
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from . import state

LIVE_ID = "live"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(n: int = 12) -> str:
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
    return state.DATA_DIR / "momo.db"


def conn() -> sqlite3.Connection:
    """进程级单连接（懒建 + schema 保证）。测试改 DATA_DIR 后调 reset()。"""
    global _conn
    with _lock:
        if _conn is None:
            _db_path().parent.mkdir(parents=True, exist_ok=True)
            _prepare_database()
            c = _connect(_db_path())
            if sqlite_vec is not None:
                try:
                    c.enable_load_extension(True)
                    sqlite_vec.load(c)
                except Exception:
                    pass
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
        (LIVE_ID, now_iso(), now_iso()),
    )


CONTINUOUS_SCHEMA_VERSION = "2"


def _connect(path: Path) -> sqlite3.Connection:
    c = sqlite3.connect(str(path), check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    c.execute("PRAGMA journal_mode = WAL")
    return c


def _migrate_continuous(c: sqlite3.Connection) -> None:
    """Upgrade only a staging copy. Legacy slots remain immutable and separate."""
    c.execute("BEGIN IMMEDIATE")
    try:
        additions = {
            "sessions": {
                "summary_cursor": "INTEGER NOT NULL DEFAULT -1",
                "summary_version": "INTEGER NOT NULL DEFAULT 0",
            },
            "messages": {
                "event_id": "TEXT NOT NULL DEFAULT ''",
                "run_id": "TEXT NOT NULL DEFAULT ''",
                "source": "TEXT NOT NULL DEFAULT 'meeting'",
                "external_message_id": "TEXT",
                "status": "TEXT NOT NULL DEFAULT 'shown'",
                "visible": "INTEGER NOT NULL DEFAULT 1",
                "display_text": "TEXT",
            },
        }
        for table, columns in additions.items():
            existing = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
            for name, declaration in columns.items():
                if name not in existing:
                    c.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
        c.execute(
            "CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,generation INTEGER NOT NULL,at TEXT NOT NULL,source TEXT NOT NULL,external_message_id TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
        )
        c.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS run_external_identity ON runs(source,external_message_id) WHERE external_message_id IS NOT NULL"
        )
        c.execute(
            "CREATE TABLE IF NOT EXISTS memory_sources(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,event_id TEXT NOT NULL,PRIMARY KEY(memory_id,event_id))"
        )
        c.execute(
            "CREATE TABLE IF NOT EXISTS pending_memory_mutations(run_id TEXT NOT NULL,memory_id TEXT NOT NULL,operation TEXT NOT NULL,content TEXT,pinned INTEGER,generation INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(run_id,memory_id))"
        )
        c.execute(
            "CREATE TABLE IF NOT EXISTS suppressed_sources(event_id TEXT PRIMARY KEY,forgotten_at TEXT NOT NULL)"
        )
        # Only the legacy conversion infers adjacent sentences. New writes always
        # carry explicit identities and never depend on their textual neighbours.
        for session in c.execute("SELECT id,generation FROM sessions").fetchall():
            run = ""
            for row in c.execute(
                "SELECT seq,role,at,event_id,run_id FROM messages WHERE session_id=? ORDER BY seq",
                (session["id"],),
            ).fetchall():
                if row["role"] == "user" or not run:
                    run = uuid.uuid5(
                        uuid.NAMESPACE_URL, f"momo:legacy:{session['id']}:{row['seq']}"
                    ).hex
                eid = (
                    row["event_id"]
                    or uuid.uuid5(
                        uuid.NAMESPACE_URL, f"momo:event:{session['id']}:{row['seq']}"
                    ).hex
                )
                rid = row["run_id"] or run
                c.execute(
                    "UPDATE messages SET event_id=?,run_id=? WHERE session_id=? AND seq=?",
                    (eid, rid, session["id"], row["seq"]),
                )
                if session["id"] == LIVE_ID:
                    c.execute(
                        "INSERT OR IGNORE INTO runs VALUES(?,?,?,'legacy',NULL,'completed',?,?)",
                        (rid, session["generation"], row["at"], row["at"], row["at"]),
                    )
        c.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS message_event_identity ON messages(event_id)"
        )
        c.execute("CREATE INDEX IF NOT EXISTS messages_run ON messages(run_id)")
        c.execute(
            "INSERT OR REPLACE INTO meta(key,value) VALUES('continuous_schema',?)",
            (CONTINUOUS_SCHEMA_VERSION,),
        )
        c.commit()
    except BaseException:
        c.rollback()
        raise


def _prepare_database() -> None:
    path = _db_path()
    existed = path.exists() and path.stat().st_size > 0
    original = _connect(path)
    try:
        original.executescript(_SCHEMA)
        _ensure_live(original)
        original.commit()
        version = original.execute(
            "SELECT value FROM meta WHERE key='continuous_schema'"
        ).fetchone()
        if version and version["value"] == CONTINUOUS_SCHEMA_VERSION:
            return
        # SQLite online backup captures WAL state consistently. Migrate the copy,
        # validate, then install atomically; an exception leaves the source intact.
        migration_dir = path.parent / "migrations"
        migration_dir.mkdir(exist_ok=True)
        if existed:
            backup_path = migration_dir / f"pre-v3-{uuid.uuid4().hex}.sqlite3"
            with sqlite3.connect(backup_path) as backup:
                original.backup(backup)
        with tempfile.TemporaryDirectory(prefix=".v3-stage-", dir=path.parent) as tmp:
            stage = Path(tmp) / "momo.db"
            with sqlite3.connect(stage) as staged:
                original.backup(staged)
                staged.row_factory = sqlite3.Row
                staged.execute("PRAGMA journal_mode=DELETE")
                staged.execute("PRAGMA foreign_keys=ON")
                _migrate_continuous(staged)
                if staged.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("Continuous-life migration integrity failure")
            staged.close()
            original.close()
            os.replace(stage, path)
    finally:
        original.close()
