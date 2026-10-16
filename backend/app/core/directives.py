"""剥离 LLM 输出里的 <exp>/<motion> 指令。

落库与回喂上下文都用正文：指令标记留在 history 里只会教模型继续输出指令。
与前端 `llm/directives.ts` 是同一套协议的两端。
"""

from __future__ import annotations

import re

#: 指令 + 其后的行内空白（指令被移除后行首可能留下空白）。
_DIRECTIVE = re.compile(r"<(exp|motion)>[^<]*</\1>[^\S\n]*")


def strip_directives(text: str) -> str:
    """移除表情/动作指令，返回可展示、可落库的正文。"""
    without = _DIRECTIVE.sub("", text)
    return "\n".join(line.lstrip() for line in without.split("\n")).strip()
