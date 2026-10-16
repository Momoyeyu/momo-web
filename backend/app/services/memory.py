"""长期记忆服务：四个操作的编排。

本文件上半部就是 `modules/memory.md` 的四张流程图，机制全部沉在别处：

    add_memory     校验 → 去重 → 写入
    search_memories 候选集 → 语义召回（embedding 不可用则词面降级）
    update_memory  校验 → 存在性 → 去重 → 改写内容（旧向量失效）
    delete_memory  删行（连同向量行）

机制层：
    repository/memories.py   memories 表 SQL
    repository/vectors.py    memory_vec（sqlite-vec）读写
    client/embed.py          embedding 调用
    common/text.py           归一化与 bigram Jaccard

能力层的 pin 拦截（工具不可改/删初始记忆）不在这里——见 service/capability.py。
"""

from __future__ import annotations

from typing import Any

from ..core import embed
from ..core.text import bigrams, jaccard, normalize
from ..core import db
from ..core.state import load as load_state
from ..models import Memory, MemoryRef
from ..models import memories, vectors

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
        memories.insert(conn, mem)
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
        memories.set_content(conn, mem_id, content)
        vectors.drop(conn, mem_id)
    updated = memories.row_by_id(mem_id)
    if updated is None:
        raise MemoryError("记忆不存在", kind="not_found")
    return updated


def delete_memory(mem_id: str) -> Memory:
    """删除一条记忆（REST/存储层不区分 pin；能力层另行拦截 pin）。"""
    with db.tx() as conn:
        row = memories.row_in(conn, mem_id)
        if row is None:
            raise MemoryError("记忆不存在或不可删除", kind="not_found")
        memories.delete(conn, mem_id)
        vectors.drop(conn, mem_id)
    return row


def set_pinned(mem_id: str, pinned: bool) -> Memory:
    """切换 pinned 标记（内容不变，无需重算向量）。"""
    require(mem_id)
    with db.tx() as conn:
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
    for mem in memories.all_rows():
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
    """当前生效的 embedding 配置。

    设置页「通用-语义检索」关闭（general.semanticSearch=false）时返回 {}，
    与 url 未配置等价——调用方走词面兜底。
    """
    state = load_state()
    if state["settings"]["general"]["semanticSearch"] is False:
        return {}
    cfg = state["settings"]["embedding"]
    # isinstance 是真防御：momo.yaml 被写成非 dict 时降级为「未配置」
    return cfg if isinstance(cfg, dict) else {}


def semantic_rank(query: str, candidates: list[Memory]) -> list[MemoryRef] | None:
    """语义召回：cosine KNN 粗排 top-15 → 0.7·cosine + 0.3·recency 精排 top-5。

    recency = 候选序号(1-based)/总数（越新分越高）。
    embedding 未配置/不可达，或 vec 表不可用 → None（调用方降级词面）。
    """
    cfg = embedding_config()
    query_vec = embed.embed(query, cfg)
    if query_vec is None or not vectors.ensure(len(query_vec)):
        return None

    _fill_missing_vectors(candidates, cfg)
    hits = vectors.knn(query_vec, min(COARSE_TOP, len(candidates)))
    order = {m["id"]: i for i, m in enumerate(candidates)}
    content_of = {m["id"]: m["content"] for m in candidates}
    scored = [
        (W_SEMANTIC * (1.0 - dist) + W_RECENCY * ((order[mid] + 1) / len(candidates)), mid)
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
        (jaccard(grams, bigrams(m["content"])), i, m)
        for i, m in enumerate(candidates)
    ]
    top = sorted(
        (s for s in scored if s[0] > 0),
        key=lambda x: (x[0], x[1]),
        reverse=True,
    )[:FINAL_TOP]
    return [{"id": m["id"], "content": m["content"]} for _, _, m in top]


def _fill_missing_vectors(candidates: list[Memory], cfg: dict[str, Any]) -> None:
    """候选中缺向量的懒算补写（逐条 embed，失败跳过本轮）。

    注意：embed 在写事务内发起（沿用既有行为——代价是持锁期间有网络往返）。
    """
    have = vectors.have_ids()
    missing = [m for m in candidates if m["id"] not in have]
    if not missing:
        return
    want_dim = vectors.dim()
    with db.tx() as conn:
        for mem in missing:
            vec = embed.embed(mem["content"], cfg)
            if vec is not None and len(vec) == want_dim:
                vectors.put(conn, mem["id"], vec)
