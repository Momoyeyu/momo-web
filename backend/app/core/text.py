"""文本相似度：归一化 + 字符 bigram Jaccard。

两处共用：记忆去重判定（归一化全等，或 Jaccard 超过阈值），
以及 embedding 不可用时的词面召回降级。归一化口径与前端保持一致。
"""

from __future__ import annotations

import unicodedata


def normalize(text: str) -> str:
    """小写 + 去标点/符号/空白，用于等价判定。"""
    return "".join(
        ch
        for ch in text.lower()
        if not ch.isspace() and unicodedata.category(ch)[0] not in ("P", "S")
    )


def bigrams(text: str) -> set[str]:
    """字符 bigram 集合（中英通用；单字符退化为自身）。"""
    n = normalize(text)
    if len(n) <= 1:
        return {n} if n else set()
    return {n[i : i + 2] for i in range(len(n) - 1)}


def jaccard(a: set[str], b: set[str]) -> float:
    """两集合的 Jaccard 相似度；都为空视为完全相似（1.0）。"""
    inter = len(a & b)
    union = len(a) + len(b) - inter
    return 1.0 if union == 0 else inter / union
