"""普通记忆存储：data/memories.json。

- 条目 schema：{id, content, createdAt}，id = uuid4 hex 前 12 位。
- pin（初始记忆）存在 state.pins，不在此文件；search 时合并参与召回，
  pin 的结果 id 形如 "pin:<sha256[:12]>"。
- embedding 缓存：data/memory-embeddings.json，key = sha256(content)，
  普通记忆与 pin 共用；缺失条目在搜索时懒算并落盘。
- embedding 端点取 state.settings.embedding（embed.py），未配置/不可达
  时 search 降级 bigram Jaccard。
"""
from __future__ import annotations

import hashlib
import json
import math
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from . import embed as embed_mod
from . import store as store_mod
from .store import DATA_DIR

MEMORIES_PATH = DATA_DIR / "memories.json"
EMBEDDINGS_PATH = DATA_DIR / "memory-embeddings.json"

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


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


# ---------- 文件读写 ----------

def _load() -> list[dict[str, Any]]:
    try:
        data = json.loads(MEMORIES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []
    return [m for m in data if isinstance(m, dict)] if isinstance(data, list) else []


def _save(mems: list[dict[str, Any]]) -> None:
    MEMORIES_PATH.parent.mkdir(parents=True, exist_ok=True)
    MEMORIES_PATH.write_text(
        json.dumps(mems, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _load_cache() -> dict[str, list[float]]:
    try:
        data = json.loads(EMBEDDINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _save_cache(cache: dict[str, list[float]]) -> None:
    EMBEDDINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    EMBEDDINGS_PATH.write_text(
        json.dumps(cache, ensure_ascii=False), encoding="utf-8"
    )


def _hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def pin_id(content: str) -> str:
    """pin 在 search 结果里的伪 id。"""
    return "pin:" + _hash(content)[:12]


# ---------- CRUD ----------

def list_memories() -> list[dict[str, Any]]:
    """普通记忆列表（不含 pin）。"""
    return _load()


def _validate(content: str) -> str:
    c = (content or "").strip()
    if not c:
        raise MemoryError("记忆内容为空，未添加")
    if len(c) > MAX_CONTENT_LEN:
        raise MemoryError(f"记忆超过 {MAX_CONTENT_LEN} 字上限，未添加")
    return c


def _find_duplicate(
    content: str, pins: Iterable[str] = (), exclude_id: str | None = None
) -> dict[str, str] | None:
    """去重判定：归一化全等或 bigram Jaccard>0.85。

    命中返回冲突条目 {id, content}（pin 的 id 是 pin:* 伪 id）——
    设计约定判重时把 id 一并回给模型，下一轮可直接 memory_update 修正。
    """
    nc = normalize(content)
    cb = bigrams(content)
    candidates = [(str(m["content"]), str(m.get("id"))) for m in _load()]
    candidates += [(p, pin_id(p)) for p in pins if isinstance(p, str)]
    for text, mid in candidates:
        if mid == exclude_id:
            continue
        if normalize(text) == nc or (cb and jaccard(cb, bigrams(text)) > DUP_JACCARD):
            return {"id": mid, "content": text}
    return None


def _dup_error(dup: dict[str, str]) -> MemoryError:
    return MemoryError(
        f"与已有记忆重复：id={dup['id']} content={dup['content']}",
        kind="duplicate",
    )


def add_memory(content: str, pins: Iterable[str] = ()) -> dict[str, Any]:
    """新增普通记忆；校验/去重失败抛 MemoryError（agent 转成 tool result）。"""
    c = _validate(content)
    dup = _find_duplicate(c, pins)
    if dup is not None:
        raise _dup_error(dup)
    mem = {"id": _new_id(), "content": c, "createdAt": _now_iso()}
    mems = _load()
    mems.append(mem)
    _save(mems)
    return mem


def edit_memory(
    mem_id: str, content: str, pins: Iterable[str] = ()
) -> dict[str, Any]:
    """原地编辑（保留 id/createdAt）；缓存按内容 hash，旧 embedding 自动失效。

    pin:* 不在普通记忆中 → not_found（设计：pin 只能在设置页手动维护）。
    """
    c = _validate(content)
    mems = _load()
    for i, m in enumerate(mems):
        if m.get("id") == mem_id:
            dup = _find_duplicate(c, pins, exclude_id=mem_id)
            if dup is not None:
                raise _dup_error(dup)
            mems[i] = {"id": mem_id, "content": c, "createdAt": m.get("createdAt") or _now_iso()}
            _save(mems)
            return mems[i]
    raise MemoryError("记忆不存在", kind="not_found")


def delete_memory(mem_id: str) -> dict[str, Any]:
    """删除普通记忆；pin:* 与未知 id 抛 MemoryError。"""
    if str(mem_id).startswith("pin:"):
        raise MemoryError("初始记忆（pin）不可删除", kind="invalid")
    mems = _load()
    for i, m in enumerate(mems):
        if m.get("id") == mem_id:
            gone = mems.pop(i)
            _save(mems)
            return gone
    raise MemoryError("记忆不存在或不可删除", kind="not_found")


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


# ---------- 搜索 ----------

def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _embed_cfg() -> dict[str, Any]:
    """state.settings.embedding；state 缺失时 normalize 补出厂默认。"""
    state = store_mod.normalize_state(store_mod.read_state())
    cfg = (state.get("settings") or {}).get("embedding")
    return cfg if isinstance(cfg, dict) else {}


def search_memories(
    query: str, pins: Iterable[str] = ()
) -> list[dict[str, str]]:
    """RAG 召回 top-5 [{id,content}]（普通记忆 + pin 合并排序）。

    embedding 可用：cosine 粗排 top-15 → 0.7*cosine+0.3*recency 精排 top-5
    （recency = 候选序号(1-based)/总数，候选序 = 普通记忆文件序 + pin 序）。
    embedding 未配置/不可达：bigram Jaccard 排序（score>0）top-5。
    """
    q = (query or "").strip()
    items: list[dict[str, str]] = [
        {"id": str(m.get("id")), "content": str(m.get("content", ""))}
        for m in _load()
    ]
    items += [{"id": pin_id(p), "content": p} for p in pins if isinstance(p, str)]
    if not q or not items:
        return []

    cfg = _embed_cfg()
    qv = embed_mod.embed(q, cfg)
    n = len(items)

    if qv is not None:
        cache = _load_cache()
        dirty = False
        scored: list[tuple[float, int, dict[str, str]]] = []
        for i, it in enumerate(items):
            h = _hash(it["content"])
            vec = cache.get(h)
            if vec is None:
                vec = embed_mod.embed(it["content"], cfg)  # 懒算并落盘
                if vec is not None:
                    cache[h] = vec
                    dirty = True
            cos = _cosine(qv, vec) if vec else 0.0
            scored.append((cos, i, it))
        if dirty:
            _save_cache(cache)
        coarse = sorted(scored, key=lambda x: (x[0], x[1]), reverse=True)[:COARSE_TOP]
        ranked = sorted(
            coarse,
            key=lambda x: W_SEMANTIC * x[0] + W_RECENCY * ((x[1] + 1) / n),
            reverse=True,
        )[:FINAL_TOP]
        return [{"id": it["id"], "content": it["content"]} for _, _, it in ranked]

    # lexical 降级：bigram Jaccard
    qb = bigrams(q)
    scored = [
        (jaccard(qb, bigrams(it["content"])), i, it) for i, it in enumerate(items)
    ]
    ranked = sorted(
        (s for s in scored if s[0] > 0),
        key=lambda x: (x[0], x[1]),
        reverse=True,
    )[:FINAL_TOP]
    return [{"id": it["id"], "content": it["content"]} for _, _, it in ranked]
