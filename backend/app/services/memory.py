"""长期记忆服务：四个操作的编排，机制全部沉在别处。

    add_memory      校验 → 去重 → 写入
    search_memories 候选集 → 语义召回（embedding 不可用则词面降级）
    update_memory   校验 → 存在性 → 去重 → 改写内容（旧向量失效）
    delete_memory   删行（连同向量行）

机制层：
    models/memories.py   memories 表 SQL
    models/vectors.py    memory_vec（sqlite-vec）读写
    core/embed.py        embedding 调用
    core/text.py         归一化与 bigram Jaccard

pin 拦截（工具不可改/删初始记忆）不在这里 —— 见 services/capability.py。
"""

from __future__ import annotations

from typing import Any
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from concurrent.futures import ThreadPoolExecutor, Future

from ..core import embed
from ..core.text import bigrams, jaccard, normalize
from ..core import db
from ..models import Memory, MemoryRef
from ..models import memories, vectors

MAX_CONTENT_LEN = 500
DUP_JACCARD = 0.85
COARSE_TOP = 15
FINAL_TOP = 5
# E5 cosine scores cluster closely: recency is a small tie preference.
W_SEMANTIC = 0.95
W_RECENCY = 0.05


class MemoryError(Exception):
    """记忆操作失败。kind: invalid(校验) / duplicate(去重) / not_found。

    不直接向用户抛：agent 捕获后作为 tool result 文本回给模型，
    REST 层按 kind 映射状态码。
    """

    def __init__(self, message: str, kind: str = "invalid") -> None:
        super().__init__(message)
        self.kind = kind


_sources: ContextVar[tuple[str, ...]] = ContextVar("memory_sources", default=())
_source_generation: ContextVar[int | None] = ContextVar(
    "memory_source_generation", default=None
)


@contextmanager
def source_scope(event_ids, generation=None):
    """Bind provenance to one execution, never a process-global current user."""
    token = _sources.set(tuple(dict.fromkeys(str(x) for x in event_ids if x)))
    gen_token = _source_generation.set(generation)
    try:
        yield
    finally:
        _sources.reset(token)
        _source_generation.reset(gen_token)


def _check_generation(conn):
    expected = _source_generation.get()
    if expected is not None:
        current = conn.execute(
            "SELECT generation FROM sessions WHERE id='live'"
        ).fetchone()
        if current is None or int(current["generation"]) != expected:
            raise MemoryError(
                "The source run was cancelled or restored; memory write rejected",
                kind="stale",
            )


def _check_sources(conn, ids):
    _check_generation(conn)
    if any(
        conn.execute(
            "SELECT 1 FROM suppressed_sources WHERE event_id=?", (eid,)
        ).fetchone()
        for eid in ids
    ):
        raise MemoryError(
            "This source was forgotten; provide a new conversation source to relearn it",
            kind="forgotten",
        )


def _suppress_memory_sources(conn, mem_id, protected=()):
    ids = [
        r["event_id"]
        for r in conn.execute(
            "SELECT event_id FROM memory_sources WHERE memory_id=?", (mem_id,)
        )
    ]
    # Legacy/manual memories have no proven origin. Conservatively suppress the
    # existing transcript, rather than accidentally reconstructing a forgotten fact.
    if not ids:
        ids = [
            r["event_id"]
            for r in conn.execute(
                "SELECT event_id FROM messages WHERE session_id='live'"
            )
        ]
    for eid in ids:
        if eid in protected:
            continue
        conn.execute(
            "INSERT OR IGNORE INTO suppressed_sources(event_id,forgotten_at) VALUES(?,?)",
            (eid, db.now_iso()),
        )
    conn.execute(
        "UPDATE sessions SET summary='',summary_cursor=-1,summary_version=summary_version+1 WHERE id='live'"
    )


def _replace_sources(conn, mem_id, event_ids):
    conn.execute("DELETE FROM memory_sources WHERE memory_id=?", (mem_id,))
    for eid in event_ids:
        conn.execute(
            "INSERT OR IGNORE INTO memory_sources(memory_id,event_id) VALUES(?,?)",
            (mem_id, eid),
        )


def _cancel_stale_prompt_on_manual_edit(conn):
    if not _sources.get() and _source_generation.get() is None:
        conn.execute("UPDATE sessions SET generation=generation+1 WHERE id='live'")


def _stage_pending(conn, operation, mem_id, content=None, pinned=None):
    ids = _sources.get()
    if not ids:
        return False
    rows = [
        conn.execute(
            "SELECT run_id,visible FROM messages WHERE event_id=?", (eid,)
        ).fetchone()
        for eid in ids
    ]
    if any(r and r["visible"] for r in rows):
        return False
    run_id = next((r["run_id"] for r in rows if r), None)
    if run_id is None:
        raise MemoryError("Memory source is not a recorded event", kind="invalid")
    gen = int(
        conn.execute("SELECT generation FROM sessions WHERE id='live'").fetchone()[0]
    )
    conn.execute(
        "INSERT OR REPLACE INTO pending_memory_mutations(run_id,memory_id,operation,content,pinned,generation) VALUES(?,?,?,?,?,?)",
        (run_id, mem_id, operation, content, pinned, gen),
    )
    return True


def apply_pending(conn, run_id):
    """Called in the display ACK transaction; no side effects outside SQLite."""
    gen = int(
        conn.execute("SELECT generation FROM sessions WHERE id='live'").fetchone()[0]
    )
    for item in conn.execute(
        "SELECT * FROM pending_memory_mutations WHERE run_id=? AND status='pending'",
        (run_id,),
    ).fetchall():
        row = memories.row_in(conn, item["memory_id"])
        if row is None or int(item["generation"]) != gen:
            status = "cancelled"
        else:
            fresh = [
                r["event_id"]
                for r in conn.execute(
                    "SELECT event_id FROM messages WHERE run_id=?", (run_id,)
                )
            ]
            if item["operation"] in {"update", "delete"}:
                _suppress_memory_sources(
                    conn,
                    item["memory_id"],
                    protected=fresh if item["operation"] == "update" else (),
                )
                vectors.drop(conn, item["memory_id"])
            if item["operation"] == "update":
                memories.set_content(conn, item["memory_id"], item["content"])
                fresh = [
                    r["event_id"]
                    for r in conn.execute(
                        "SELECT event_id FROM messages WHERE run_id=?", (run_id,)
                    )
                ]
                _replace_sources(conn, item["memory_id"], fresh)
            elif item["operation"] == "delete":
                memories.delete(conn, item["memory_id"])
            elif item["operation"] == "pin":
                memories.set_pinned(conn, item["memory_id"], bool(item["pinned"]))
            status = "applied"
        conn.execute(
            "UPDATE pending_memory_mutations SET status=? WHERE run_id=? AND memory_id=?",
            (status, run_id, item["memory_id"]),
        )


# ==================== 对外操作 ====================


def add_memory(content: str, pinned: bool = False) -> Memory:
    """新增记忆（pinned=True 即初始记忆）；校验/去重失败抛 MemoryError。"""
    content = validate(content)
    reject_duplicate(content)
    mem: Memory = {
        "id": db.new_id(),
        "content": content,
        "createdAt": db.now_iso(),
        "pinned": pinned,
    }
    with db.tx() as conn:
        _check_sources(conn, _sources.get())
        memories.insert(conn, mem)
        for eid in _sources.get():
            conn.execute(
                "INSERT INTO memory_sources(memory_id,event_id) VALUES(?,?)",
                (mem["id"], eid),
            )
    schedule_index()
    return mem


def search_memories(query: str) -> list[MemoryRef]:
    """RAG 召回 top-5（pin 与普通记忆合并排序）。

    embedding 可用 → 语义召回；不可用 → 词面匹配。
    注意 `is not None` 判断：语义分支返回空列表是**有效结果**，不再降级。
    """
    query = (query or "").strip()
    candidates = memories.all_rows()
    if not query or not candidates:
        return []
    ranked = semantic_rank(query, candidates)
    return ranked if ranked is not None else lexical_rank(query, candidates)


def update_memory(mem_id: str, content: str) -> Memory:
    """原地编辑（保留 id/createdAt）；旧向量删除，召回时懒算补回。"""
    content = validate(content)
    require(mem_id)
    reject_duplicate(content, exclude_id=mem_id)
    with db.tx() as conn:
        _check_sources(conn, _sources.get())
        if _stage_pending(conn, "update", mem_id, content=content):
            return {**memories.row_in(conn, mem_id), "content": content}
        _suppress_memory_sources(conn, mem_id, protected=_sources.get())
        memories.set_content(conn, mem_id, content)
        _replace_sources(conn, mem_id, _sources.get())
        _cancel_stale_prompt_on_manual_edit(conn)
        vectors.drop(conn, mem_id)
    schedule_index()
    updated = memories.row_by_id(mem_id)
    if updated is None:
        raise MemoryError("记忆不存在", kind="not_found")
    return updated


def delete_memory(mem_id: str) -> Memory:
    """删除一条记忆（REST/存储层不区分 pin；能力层另行拦截 pin）。"""
    with db.tx() as conn:
        _check_sources(conn, _sources.get())
        row = memories.row_in(conn, mem_id)
        if row is None:
            raise MemoryError("记忆不存在或不可删除", kind="not_found")
        if _stage_pending(conn, "delete", mem_id):
            return row
        _suppress_memory_sources(conn, mem_id)
        _cancel_stale_prompt_on_manual_edit(conn)
        memories.delete(conn, mem_id)
        vectors.drop(conn, mem_id)
    return row


def set_pinned(mem_id: str, pinned: bool) -> Memory:
    """切换 pinned 标记（内容不变，无需重算向量）。"""
    require(mem_id)
    with db.tx() as conn:
        _check_sources(conn, _sources.get())
        if _stage_pending(conn, "pin", mem_id, pinned=int(pinned)):
            return {**memories.row_in(conn, mem_id), "pinned": pinned}
        memories.set_pinned(conn, mem_id, pinned)
    updated = memories.row_by_id(mem_id)
    if updated is None:
        raise MemoryError("记忆不存在", kind="not_found")
    return updated


# ==================== 查询辅助 ====================


def list_memories(pinned: bool | None = None) -> list[Memory]:
    """记忆列表；pinned 过滤（None = 全部）。pin 的 id 也是真实行 id。"""
    return memories.all_rows(pinned)


def pins() -> list[str]:
    """初始记忆文本列表（prompt 注入用）。"""
    return [m["content"] for m in memories.all_rows(pinned=True)]


def is_pinned(mem_id: str) -> bool:
    row = memories.row_by_id(mem_id)
    return bool(row and row["pinned"])


# ==================== 业务规则 ====================


def validate(content: str) -> str:
    """校验并规范化内容；不合法抛 invalid。"""
    text = (content or "").strip()
    if not text:
        raise MemoryError("记忆内容为空，未添加")
    if len(text) > MAX_CONTENT_LEN:
        raise MemoryError(f"记忆超过 {MAX_CONTENT_LEN} 字上限，未添加")
    return text


def require(mem_id: str) -> None:
    """记忆必须存在，否则抛 not_found。"""
    if not memories.exists(mem_id):
        raise MemoryError("记忆不存在", kind="not_found")


def reject_duplicate(content: str, exclude_id: str | None = None) -> None:
    """与已有记忆（候选含 pin 行）重复则抛 duplicate。

    判重口径：归一化全等，或 bigram Jaccard > DUP_JACCARD。
    设计约定把冲突条目的 id 一并回给模型，下一轮可直接 update 修正。
    """
    normalized = normalize(content)
    grams = bigrams(content)
    candidates = memories.all_rows()
    known = {m["id"] for m in candidates}
    for eid in _sources.get():
        for r in db.query(
            "SELECT m.* FROM memories m JOIN memory_sources ms ON ms.memory_id=m.id WHERE ms.event_id=?",
            (eid,),
        ):
            if r["id"] not in known:
                candidates.append(
                    {
                        "id": r["id"],
                        "content": r["content"],
                        "createdAt": r["created_at"],
                        "pinned": bool(r["pinned"]),
                    }
                )
                known.add(r["id"])
    for mem in candidates:
        if mem["id"] == exclude_id:
            continue
        same = normalize(mem["content"]) == normalized
        similar = bool(grams) and jaccard(grams, bigrams(mem["content"])) > DUP_JACCARD
        if same or similar:
            raise MemoryError(
                f"与已有记忆重复：id={mem['id']} content={mem['content']}",
                kind="duplicate",
            )


# ==================== 召回 ====================


def embedding_config() -> dict[str, Any]:
    """Local bundled inference, independent of legacy remote configuration."""
    return {"kind": "local"}


def semantic_rank(query: str, candidates: list[Memory]) -> list[MemoryRef] | None:
    """语义召回：cosine KNN 粗排 top-15 → 0.95·cosine + 0.05·recency 精排 top-5。

    recency = 候选序号(1-based)/总数（越新分越高）。
    embedding 未配置/不可达，或 vec 表不可用 → None（调用方降级词面）。
    """
    cfg = embedding_config()
    query_vec = embed.embed(query, cfg)
    if query_vec is None:
        schedule_index()
        return None
    try:
        with db._lock:
            if not vectors.ensure(len(query_vec), embed.MODEL_ID):
                return None
            missing = bool(vectors.missing(1))
            if not missing:
                if memories.all_rows() != candidates:
                    return None
                hits = vectors.knn(query_vec, min(COARSE_TOP, len(candidates)))
        # Never enter the scheduler while holding the database lock.
        if missing:
            schedule_index()
            return None
    except Exception:
        schedule_index()
        return None
    order = {m["id"]: i for i, m in enumerate(candidates)}
    content_of = {m["id"]: m["content"] for m in candidates}
    scored = [
        (
            W_SEMANTIC * (1.0 - dist)
            + W_RECENCY * ((order[mid] + 1) / len(candidates)),
            mid,
        )
        for mid, dist in hits
        if mid in order
    ]
    # 稳定排序：同分保持 KNN 的距离序
    top = sorted(scored, key=lambda x: x[0], reverse=True)[:FINAL_TOP]
    return [{"id": mid, "content": content_of[mid]} for _, mid in top]


def lexical_rank(query: str, candidates: list[Memory]) -> list[MemoryRef]:
    """词面降级：bigram Jaccard > 0，按 (分数, 候选序) 降序取 top-5。"""
    grams = bigrams(query)
    scored = [
        (jaccard(grams, bigrams(m["content"])), i, m) for i, m in enumerate(candidates)
    ]
    top = sorted(
        (s for s in scored if s[0] > 0),
        key=lambda x: (x[0], x[1]),
        reverse=True,
    )[:FINAL_TOP]
    return [{"id": m["id"], "content": m["content"]} for _, _, m in top]


# A single worker, bounded batches, and a bounded ORT thread pool.
_index_lock = threading.Lock()
_executor: ThreadPoolExecutor | None = None
_future: Future | None = None
_index_error: str | None = None
_stopping = False
_index_requested = threading.Event()


_requested_connection = None


def _submit_index_locked(connection) -> Future:
    """Caller owns only _index_lock; this helper never acquires a DB lock."""
    global _executor, _future
    if _executor is None:
        _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="memory-index")
    _index_requested.clear()
    _future = _executor.submit(rebuild_index, connection)
    return _future


def _index_finished(future: Future) -> None:
    # Preserve requests arriving after the last empty-batch read, including a
    # request for a replacement DB. Never open a connection from a late callback.
    with _index_lock:
        if (
            future is not _future
            or _stopping
            or not _index_requested.is_set()
            or _requested_connection is not db._conn
        ):
            return
        try:
            replacement = _submit_index_locked(_requested_connection)
        except RuntimeError:
            return  # Executor/interpreter shutdown has already started.
    replacement.add_done_callback(_index_finished)


def schedule_index() -> None:
    global _requested_connection
    # db.conn takes db._lock: acquire it before entering the scheduler lock and
    # release it first. No scheduler path waits for the DB while owning its lock.
    connection = db.conn()
    with _index_lock:
        if _stopping or connection is not db._conn:
            return
        _requested_connection = connection
        _index_requested.set()
        if _future is not None and not _future.done():
            return
        future = _submit_index_locked(connection)
    future.add_done_callback(_index_finished)


def shutdown_index() -> None:
    global _executor, _future, _stopping, _requested_connection
    with _index_lock:
        _stopping = True
        executor, _executor = _executor, None
    if executor is not None:
        executor.shutdown(wait=True, cancel_futures=True)
    with _index_lock:
        _future = None
        _requested_connection = None
        _index_requested.clear()
        _stopping = False


def rebuild_index(connection=None) -> None:
    """Recover in batches; commit only if source text and generation still match.

    Connection identity prevents jobs for a closed database from targeting its
    replacement. Inference always runs outside the DB lock and transaction.
    """
    global _index_error
    connection = connection if connection is not None else db.conn()
    try:
        with db._lock:
            if db._conn is not connection:
                return
            old_dim = (
                vectors.dim()
                if db.meta_get("vec_namespace") == embed.MODEL_ID
                else None
            )
            if not vectors.ensure(old_dim or embed.DIMENSION, embed.MODEL_ID):
                _index_error = "SQLite vector extension unavailable"
                return
        while not _stopping:
            with db._lock:
                if db._conn is not connection:
                    return
                batch = vectors.missing(16)
                generation = db.meta_get("vec_generation")
            if not batch:
                _index_error = None
                return
            progress = False
            for mem in batch:
                if _stopping:
                    return
                vec = embed.embed(mem["content"], {"kind": "local", "role": "passage"})
                if vec is None:
                    _index_error = (
                        "Local embedding unavailable; lexical recall remains active"
                    )
                    return
                with db._lock:
                    if (
                        db._conn is not connection
                        or db.meta_get("vec_generation") != generation
                    ):
                        return
                    if len(vec) != vectors.dim():
                        if not vectors.ensure(len(vec), embed.MODEL_ID):
                            return
                        generation = db.meta_get("vec_generation")
                    with db.tx() as conn:
                        progress |= vectors.put_current(
                            conn, mem["id"], mem["content"], vec, generation
                        )
            if not progress:
                return
    except Exception as exc:
        _index_error = f"{type(exc).__name__}: {exc}"


def index_status() -> dict[str, Any]:
    """Read-only inspection; no model load or job scheduling."""
    total = len(memories.all_rows())
    indexed = 0
    namespace = db.meta_get("vec_namespace")
    try:
        if namespace == embed.MODEL_ID and vectors.dim():
            indexed = int(
                db.query(
                    "SELECT COUNT(*) AS n FROM memories m "
                    "JOIN memory_vec_sources s ON m.id=s.id AND m.content=s.content "
                    "JOIN memory_vec v ON m.id=v.id"
                )[0]["n"]
            )
    except Exception:
        pass
    active = _future is not None and not _future.done()
    status = (
        "indexing"
        if active
        else (
            "degraded" if _index_error else ("ready" if indexed == total else "pending")
        )
    )
    return {
        "state": status,
        "indexed": indexed,
        "total": total,
        "namespace": namespace,
        "error": _index_error,
    }
