"""长期记忆存储：data/momo.db 的 memories 表 + memory_vec 向量表。

- 条目 schema：{id, content, createdAt, pinned}；pinned=1 即初始记忆
  （原 state.pins 迁入，伪 id pin:* 废弃——所有记忆都是真实行 id）。
- 向量检索走 sqlite-vec vec0（cosine KNN）；候选向量缺失时懒算补写，
  embedding 未配置/不可达 → 降级 bigram Jaccard。
- 写路径走 db.tx()；能力层（capability）负责「pin 不可被工具改/删」的拦截，
  存储层与 REST 不区分（设置页手动维护 pin 走 REST）。
"""
from __future__ import annotations

import json
import math
import unicodedata
from typing import Any

from . import db, embed as embed_mod
from . import store as store_mod

MAX_CONTENT_LEN = 500
DUP_JACCARD = 0.85
COARSE_TOP = 15
FINAL_TOP = 5
W_SEMANTIC = 0.7
W_RECENCY = 0.3


class MemoryError(Exception):
    """记忆操作失败。kind: invalid(校验) / duplicate(去重) / not_found。

    不直接向用户抛：agent 捕获后作为 tool result 文本回给模型，
    REST 层按 kind 映射状态码。
    """

    def __init__(self, message: str, kind: str = "invalid") -> None:
        super().__init__(message)
        self.kind = kind
        self.duplicate = kind == "duplicate"
        self.not_found = kind == "not_found"


_now_iso = db._now_iso
_new_id = db._new_id


# ---------- 文本归一化 / bigram Jaccard（对齐前端 normalize/bigrams） ----------

def normalize(s: str) -> str:
    """小写 + 去标点/符号/空白，用于等价判定。"""
    return "".join(
        ch
        for ch in s.lower()
        if not ch.isspace() and unicodedata.category(ch)[0] not in ("P", "S")
    )


def bigrams(s: str) -> set[str]:
    """字符 bigram 集合（中英通用；单字符退化为自身）。"""
    n = normalize(s)
    if len(n) <= 1:
        return {n} if n else set()
    return {n[i : i + 2] for i in range(len(n) - 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return 1.0 if union == 0 else inter / union


# ---------- 行读取 ----------

def _row(r: Any) -> dict[str, Any]:
    return {
        "id": r["id"],
        "content": r["content"],
        "createdAt": r["created_at"],
        "pinned": bool(r["pinned"]),
    }


def _all() -> list[dict[str, Any]]:
    return [_row(r) for r in db.query("SELECT * FROM memories ORDER BY rowid")]


def list_memories(pinned: bool | None = None) -> list[dict[str, Any]]:
    """记忆列表；pinned 过滤（None=全部）。pin 的 id 也是真实行 id。"""
    if pinned is None:
        return _all()
    rows = db.query(
        "SELECT * FROM memories WHERE pinned=? ORDER BY rowid",
        (1 if pinned else 0,),
    )
    return [_row(r) for r in rows]


def pins() -> list[str]:
    """初始记忆文本列表（prompt 注入用）。"""
    return [m["content"] for m in list_memories(pinned=True)]


def is_pinned(mem_id: str) -> bool:
    rows = db.query("SELECT pinned FROM memories WHERE id=?", (mem_id,))
    return bool(rows and rows[0]["pinned"])


def _exists(mem_id: str) -> bool:
    return bool(db.query("SELECT 1 FROM memories WHERE id=?", (mem_id,)))


# ---------- CRUD ----------

def _validate(content: str) -> str:
    c = (content or "").strip()
    if not c:
        raise MemoryError("记忆内容为空，未添加")
    if len(c) > MAX_CONTENT_LEN:
        raise MemoryError(f"记忆超过 {MAX_CONTENT_LEN} 字上限，未添加")
    return c


def _find_duplicate(
    content: str, exclude_id: str | None = None
) -> dict[str, str] | None:
    """去重判定：归一化全等或 bigram Jaccard>0.85（候选含 pin 行）。

    命中返回冲突条目 {id, content}——设计约定判重时把 id 一并回给
    模型，下一轮可直接 memory_update 修正。
    """
    nc = normalize(content)
    cb = bigrams(content)
    for m in _all():
        mid = str(m["id"])
        if mid == exclude_id:
            continue
        text = str(m["content"])
        if normalize(text) == nc or (cb and jaccard(cb, bigrams(text)) > DUP_JACCARD):
            return {"id": mid, "content": text}
    return None


def _dup_error(dup: dict[str, str]) -> MemoryError:
    return MemoryError(
        f"与已有记忆重复：id={dup['id']} content={dup['content']}",
        kind="duplicate",
    )


def add_memory(content: str, pinned: bool = False) -> dict[str, Any]:
    """新增记忆（pinned=True 即初始记忆）；校验/去重失败抛 MemoryError。"""
    c = _validate(content)
    dup = _find_duplicate(c)
    if dup is not None:
        raise _dup_error(dup)
    mem_id = _new_id()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO memories(id,content,created_at,pinned) VALUES(?,?,?,?)",
            (mem_id, c, _now_iso(), 1 if pinned else 0),
        )
    return {
        "id": mem_id,
        "content": c,
        "createdAt": _now_iso(),
        "pinned": pinned,
    }


def edit_memory(mem_id: str, content: str) -> dict[str, Any]:
    """原地编辑（保留 id/createdAt）；向量按行 id 关联，编辑后旧向量失效懒算。"""
    c = _validate(content)
    if not _exists(mem_id):
        raise MemoryError("记忆不存在", kind="not_found")
    dup = _find_duplicate(c, exclude_id=mem_id)
    if dup is not None:
        raise _dup_error(dup)
    with db.tx() as conn:
        conn.execute(
            "UPDATE memories SET content=? WHERE id=?", (c, mem_id)
        )
        if db._vec_table_dim() is not None:
            conn.execute("DELETE FROM memory_vec WHERE id=?", (mem_id,))
    for r in _all():
        if r["id"] == mem_id:
            return r
    raise MemoryError("记忆不存在", kind="not_found")


def delete_memory(mem_id: str) -> dict[str, Any]:
    """删除一条记忆（REST/存储层不区分 pin；能力层另行拦截 pin）。"""
    with db.tx() as conn:
        row = conn.execute(
            "SELECT * FROM memories WHERE id=?", (mem_id,)
        ).fetchone()
        if row is None:
            raise MemoryError("记忆不存在或不可删除", kind="not_found")
        conn.execute("DELETE FROM memories WHERE id=?", (mem_id,))
        if db._vec_table_dim() is not None:
            conn.execute("DELETE FROM memory_vec WHERE id=?", (mem_id,))
    return _row(row)


def import_legacy(items: list[Any]) -> int:
    """旧版 state.memories 一次性导入：跳过 valid==False 与非字符串条目，去重。"""
    count = 0
    for it in items:
        if not isinstance(it, dict):
            continue
        if it.get("valid", True) is False:
            continue
        content = it.get("content")
        if not isinstance(content, str):
            continue
        try:
            add_memory(content)
            count += 1
        except MemoryError:
            pass
    return count


def import_pins(items: list[Any]) -> int:
    """旧版 state.pins 一次性导入为 pinned 行（PUT /api/state 兼容路径）。"""
    count = 0
    for p in items:
        if not isinstance(p, str) or not p.strip():
            continue
        try:
            add_memory(p, pinned=True)
            count += 1
        except MemoryError:
            pass
    return count


# ---------- 搜索 ----------

def _embed_cfg() -> dict[str, Any]:
    """state.settings.embedding；state 缺失时 normalize 补出厂默认。

    设置页「通用-语义检索」关闭（general.semanticSearch=false）时返回 {}，
    与 url 未配置等价——调用方走 lexical 兜底。
    """
    state = store_mod.normalize_state(store_mod.read_state())
    settings = state.get("settings") or {}
    if (settings.get("general") or {}).get("semanticSearch") is False:
        return {}
    cfg = settings.get("embedding")
    return cfg if isinstance(cfg, dict) else {}


def _vec_ids() -> set[str]:
    rows = db.query("SELECT id FROM memory_vec")
    return {r["id"] for r in rows}


def _fill_vectors(items: list[dict[str, Any]], cfg: dict[str, Any]) -> None:
    """候选中缺向量的懒算补写（逐条 embed，失败跳过本轮）。"""
    have = _vec_ids()
    missing = [it for it in items if it["id"] not in have]
    if not missing:
        return
    dim = db._vec_table_dim()
    with db.tx() as conn:
        for it in missing:
            vec = embed_mod.embed(str(it["content"]), cfg)
            if vec is not None and len(vec) == dim:
                conn.execute(
                    "INSERT OR REPLACE INTO memory_vec(id,vec) VALUES(?,?)",
                    (it["id"], json.dumps(vec)),
                )


def search_memories(query: str) -> list[dict[str, str]]:
    """RAG 召回 top-5 [{id,content}]（pin 与普通记忆合并排序）。

    embedding 可用：memory_vec cosine KNN 粗排 top-15
    → 0.7*cosine+0.3*recency 精排 top-5（recency = 候选序号(1-based)/总数）。
    embedding 未配置/不可达：bigram Jaccard 排序（score>0）top-5。
    """
    q = (query or "").strip()
    items = _all()
    if not q or not items:
        return []

    cfg = _embed_cfg()
    qv = embed_mod.embed(q, cfg)
    n = len(items)

    if qv is not None and db.ensure_vec(len(qv)):
        _fill_vectors(items, cfg)
        knn = db.query(
            "SELECT id, distance FROM memory_vec"
            " WHERE vec MATCH ? AND k = ? ORDER BY distance",
            (json.dumps([float(x) for x in qv]), min(COARSE_TOP, n)),
        )
        # cosine distance → cosine 相似度；按候选序取 recency 分
        order = {it["id"]: i for i, it in enumerate(items)}
        content_of = {it["id"]: str(it["content"]) for it in items}
        coarse = [
            (1.0 - float(r["distance"]), order[r["id"]], r["id"])
            for r in knn
            if r["id"] in order
        ]
        ranked = sorted(
            coarse,
            key=lambda x: W_SEMANTIC * x[0] + W_RECENCY * ((x[1] + 1) / n),
            reverse=True,
        )[:FINAL_TOP]
        return [{"id": mid, "content": content_of[mid]} for _, _, mid in ranked]

    # lexical 降级：bigram Jaccard
    qb = bigrams(q)
    scored = [
        (jaccard(qb, bigrams(str(it["content"]))), i, it)
        for i, it in enumerate(items)
    ]
    ranked = sorted(
        (s for s in scored if s[0] > 0),
        key=lambda x: (x[0], x[1]),
        reverse=True,
    )[:FINAL_TOP]
    return [
        {"id": str(it["id"]), "content": str(it["content"])}
        for _, _, it in ranked
    ]
