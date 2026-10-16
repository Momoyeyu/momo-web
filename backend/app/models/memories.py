"""memories 表的读写。

只做 SQL：不含校验、去重策略、召回排序——那些是 service 层的规则。

事务约定（与 config/db.py 的单连接 + BEGIN IMMEDIATE 配套）：
- 读：`all_rows` / `row_by_id` / `exists` 走 db.query()，不显式开事务；
- 写：接收调用方的连接，由 service 用 `with db.tx() as conn:` 决定事务边界，
      这样「改内容 + 删旧向量」能落在同一个事务里。
"""

from __future__ import annotations

import sqlite3

from ..core import db
from . import Memory


def _row(r: sqlite3.Row) -> Memory:
    return {
        "id": r["id"],
        "content": r["content"],
        "createdAt": r["created_at"],
        "pinned": bool(r["pinned"]),
    }


def all_rows(pinned: bool | None = None) -> list[Memory]:
    """全部记忆；pinned 过滤（None = 不过滤）。"""
    if pinned is None:
        rows = db.query("SELECT * FROM memories ORDER BY rowid")
    else:
        rows = db.query(
            "SELECT * FROM memories WHERE pinned=? ORDER BY rowid",
            (1 if pinned else 0,),
        )
    return [_row(r) for r in rows]


def row_by_id(mem_id: str) -> Memory | None:
    rows = db.query("SELECT * FROM memories WHERE id=?", (mem_id,))
    return _row(rows[0]) if rows else None


def row_in(conn: sqlite3.Connection, mem_id: str) -> Memory | None:
    """事务内点名读取（写事务里做「先查存在再删/改」）。"""
    row = conn.execute("SELECT * FROM memories WHERE id=?", (mem_id,)).fetchone()
    return _row(row) if row else None


def exists(mem_id: str) -> bool:
    return bool(db.query("SELECT 1 FROM memories WHERE id=?", (mem_id,)))


# ---------------- 写：调用方掌管事务 ----------------


def insert(conn: sqlite3.Connection, mem: Memory) -> None:
    conn.execute(
        "INSERT INTO memories(id,content,created_at,pinned) VALUES(?,?,?,?)",
        (mem["id"], mem["content"], mem["createdAt"], 1 if mem["pinned"] else 0),
    )


def set_content(conn: sqlite3.Connection, mem_id: str, content: str) -> None:
    conn.execute("UPDATE memories SET content=? WHERE id=?", (content, mem_id))


def set_pinned(conn: sqlite3.Connection, mem_id: str, pinned: bool) -> None:
    conn.execute(
        "UPDATE memories SET pinned=? WHERE id=?", (1 if pinned else 0, mem_id)
    )


def delete(conn: sqlite3.Connection, mem_id: str) -> None:
    conn.execute("DELETE FROM memories WHERE id=?", (mem_id,))
