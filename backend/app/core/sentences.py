"""回合正文切句：强标点必断，保留标点。

与前端 `chat/sentences.ts` 同一口径——前端按句播放，后端按句推 delta。
"""

from __future__ import annotations

#: 强标点：遇到即断句（含换行）。
DELIMITERS = "。！？!?…\n"


def split_segments(text: str) -> list[str]:
    """按强标点切段（保留标点）；没有标点时整段返回。"""
    segments: list[str] = []
    buffer = ""
    for ch in text:
        buffer += ch
        if ch in DELIMITERS:
            segments.append(buffer)
            buffer = ""
    if buffer:
        segments.append(buffer)
    return segments or [text]
