"""memory_vec（sqlite-vec vec0）读写：向量维护与 KNN 查询。

表：`memory_vec(id TEXT PRIMARY KEY, vec float[dim])`，cosine KNN，id 与 memories 关联。
维度跟随当前 embedding 输出。

sqlite-vec 扩展缺失、或维度与当前 embedding 不符 → 表不可用（ensure 返回 False），
service 据此把召回降级为词面匹配；记忆的读写本身不依赖向量。

事务约定同 models/memories.py：读走 db.query()，写接收调用方的连接。
"""

from __future__ import annotations

import json
import sqlite3

from ..core import db
from .memories import ACTIVE_SQL


def dim() -> int | None:
    """已建 vec 表的向量维度；未建返回 None。"""
    raw = db.meta_get("vec_dim")
    try:
        return int(raw) if raw else None
    except ValueError:
        return None


def ensure(want_dim: int, namespace: str = "legacy") -> bool:
    """保证 memory_vec 存在且维度 = want_dim；维度漂移则重建（向量可懒算补回）。"""
    if db.sqlite_vec is None or want_dim <= 0:
        return False
    with db.tx() as conn:
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vec'"
        ).fetchone()
        if exists and dim() == want_dim and db.meta_get("vec_namespace") == namespace:
            return True
        conn.execute("DROP TABLE IF EXISTS memory_vec")
        conn.execute("DROP TABLE IF EXISTS memory_vec_sources")
        conn.execute(
            f"CREATE VIRTUAL TABLE memory_vec USING vec0("
            f"id TEXT PRIMARY KEY, vec float[{int(want_dim)}] distance_metric=cosine)"
        )
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('vec_dim',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(want_dim),),
        )
        conn.execute(
            "CREATE TABLE memory_vec_sources(id TEXT PRIMARY KEY, content TEXT NOT NULL)"
        )
        for event in ("DELETE", "UPDATE OF content"):
            name = "memory_vec_invalidate_" + event.split()[0].lower()
            conn.execute(f"DROP TRIGGER IF EXISTS {name}")
            conn.execute(
                f"CREATE TRIGGER {name} AFTER {event} ON memories BEGIN "
                "DELETE FROM memory_vec WHERE id=old.id; "
                "DELETE FROM memory_vec_sources WHERE id=old.id; END"
            )
        for key, value in (
            ("vec_namespace", namespace),
            ("vec_generation", db.new_id()),
        ):
            conn.execute(
                "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
    return True


def have_ids() -> set[str]:
    """已有向量的记忆 id 集合（懒算补写的判据）。"""
    return {str(r["id"]) for r in db.query("SELECT id FROM memory_vec")}


def knn(query_vec: list[float], k: int) -> list[tuple[str, float]]:
    """cosine KNN 粗排；返回 [(记忆 id, cosine 距离)]，按距离升序。"""
    rows = db.query(
        "SELECT id, distance FROM memory_vec"
        " WHERE vec MATCH ? AND k = ? ORDER BY distance",
        (json.dumps([float(x) for x in query_vec]), k),
    )
    return [(str(r["id"]), float(r["distance"])) for r in rows]


def put(conn: sqlite3.Connection, mem_id: str, vec: list[float]) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO memory_vec(id,vec) VALUES(?,?)",
        (mem_id, json.dumps(vec)),
    )


def drop(conn: sqlite3.Connection, mem_id: str) -> None:
    """删除某条记忆的向量行；vec 表尚未建立时安全跳过。"""
    if dim() is None:
        return
    conn.execute("DELETE FROM memory_vec WHERE id=?", (mem_id,))
    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name='memory_vec_sources'"
    ).fetchone():
        conn.execute("DELETE FROM memory_vec_sources WHERE id=?", (mem_id,))


def missing(limit: int = 16) -> list[dict]:
    """Compare exact source text so direct restore/import is also recoverable."""
    return [
        dict(r)
        for r in db.query(
            "SELECT m.id,m.content FROM memories m LEFT JOIN memory_vec_sources s ON m.id=s.id "
            "LEFT JOIN memory_vec v ON m.id=v.id WHERE (s.content IS NOT m.content OR v.id IS NULL) AND "
            + ACTIVE_SQL
            + " LIMIT ?",
            (limit,),
        )
    ]


def put_current(
    conn: sqlite3.Connection,
    mem_id: str,
    content: str,
    vec: list[float],
    generation: str,
) -> bool:
    current = conn.execute(
        "SELECT m.content FROM memories m WHERE m.id=? AND " + ACTIVE_SQL, (mem_id,)
    ).fetchone()
    if (
        not current
        or current["content"] != content
        or db.meta_get("vec_generation") != generation
    ):
        return False
    put(conn, mem_id, vec)
    conn.execute(
        "INSERT OR REPLACE INTO memory_vec_sources(id,content) VALUES(?,?)",
        (mem_id, content),
    )
    return True
