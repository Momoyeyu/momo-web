"""system prompt 组装：按 settings.general.lang 选 zh/en/ja（未知语言回退 zh）。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from ..store import DEFAULT_STATE

_LANG_NAMES = {"zh": "中文", "en": "English", "ja": "日本語"}
_DEFAULT_PERSONA: dict[str, Any] = DEFAULT_STATE["persona"]

# 各语言模板片段；{...} 由 builder 注入
_T = {
    "zh": {
        "self": "关于你自己：",
        "parts": ("你的名字叫{v}", "你的身份是{v}", "你的年龄是{v}"),
        "personality": "你的性格是{v}。",
        "prefs": "你的偏好：",
        "lang_line": "你的主语言是{lang}，需要使用该语言与用户交流，除非用户特别要求使用其他语言。",
        "time_line": "目前你所在的时区是{tz}，现在的时间是{time24h}。",
        "mem": "关于记忆：\n以下是你的初始记忆：",
        "tools": "你有以下工具：\n1. memory_add\n2. memory_search\n3. memory_update\n4. memory_delete\n5. common_time",
        "joiner": "，",
        "ender": "。",
        "emotion": (
            "[情绪与动作指令]\n"
            "情绪变化时，在对应句子之前插入独立的指令 `#tag`，tag 取值：\n"
            "neutral happy sad angry surprised thinking shy sleepy。\n"
            "例如「#happy 今天好开森！」「#thinking 让我想想……」。\n"
            "指令不会被展示，也不会被朗读，只用于切换表情与动作。\n"
            "正文里不要出现任何 # 或方括号标记。"
        ),
    },
    "en": {
        "self": "About yourself:",
        "parts": ("Your name is {v}", "your identity is {v}", "you are {v} years old"),
        "personality": "Your personality: {v}.",
        "prefs": "Your preferences:",
        "lang_line": "Your primary language is {lang}; talk with the user in that language unless they explicitly ask for another one.",
        "time_line": "Your timezone is {tz}; the current time is {time24h}.",
        "mem": "About memory:\nThese are your initial memories:",
        "tools": "You have the following tools:\n1. memory_add\n2. memory_search\n3. memory_update\n4. memory_delete\n5. common_time",
        "joiner": ", ",
        "ender": ".",
        "emotion": (
            "[Emotion & motion instructions]\n"
            "When your emotion changes, insert a standalone `#tag` before the sentence. Available tags:\n"
            "neutral happy sad angry surprised thinking shy sleepy.\n"
            'e.g. "#happy I\'m so glad!" "#thinking Let me think...".\n'
            "The tag is never displayed or read aloud; it only switches expression and motion.\n"
            "Do not use any other # or bracket markup in the reply."
        ),
    },
    "ja": {
        "self": "あなた自身について：",
        "parts": ("あなたの名前は{v}", "身分は{v}", "年齢は{v}歳"),
        "personality": "性格は{v}。",
        "prefs": "あなたの好み：",
        "lang_line": "あなたの主言語は{lang}です。ユーザーが特に指定しない限り、その言語で話してください。",
        "time_line": "現在のタイムゾーンは{tz}、時刻は{time24h}です。",
        "mem": "記憶について：\n以下はあなたの初期記憶です：",
        "tools": "あなたは以下のツールを使えます：\n1. memory_add\n2. memory_search\n3. memory_update\n4. memory_delete\n5. common_time",
        "joiner": "、",
        "ender": "。",
        "emotion": (
            "[感情・モーション指示]\n"
            "感情が変わるときは、対応する文の前に独立した指令 `#tag` を挿入してください。tag の値：\n"
            "neutral happy sad angry surprised thinking shy sleepy。\n"
            "例：「#happy 今日はとても嬉しい！」「#thinking 考えさせて……」。\n"
            "指令は表示・読み上げされず、表情とモーションの切り替えにのみ使われます。\n"
            "本文に他の # や角括弧の記号を入れないでください。"
        ),
    },
}


def _lang_of(state: dict[str, Any]) -> str:
    lang = str(
        (((state.get("settings") or {}).get("general") or {}).get("lang")) or "zh"
    ).lower()
    for code in ("zh", "en", "ja"):
        if lang.startswith(code):
            return code
    return "zh"


def build_system_prompt(state: dict[str, Any]) -> str:
    """按契约模板组装 system prompt；末尾固定追加情绪指令段。"""
    lang = _lang_of(state)
    t = _T[lang]
    # 空字段回落出厂人设：用户在设置里清空=回到初始状态，
    # prompt 侧始终装配默认值（与前端 placeholder 显示一致）。
    persona = dict(state.get("persona") or {})
    for key in ("name", "identity", "personality"):
        if not str(persona.get(key) or "").strip():
            persona[key] = _DEFAULT_PERSONA[key]
    if not isinstance(persona.get("age"), (int, float)) or isinstance(
        persona.get("age"), bool
    ):
        persona["age"] = _DEFAULT_PERSONA["age"]
    if not any(str(p).strip() for p in (persona.get("preferences") or [])):
        persona["preferences"] = _DEFAULT_PERSONA["preferences"]
    pins = [
        p.strip()
        for p in (state.get("pins") or [])
        if isinstance(p, str) and p.strip()
    ]

    now = datetime.now().astimezone()
    tz = now.tzname() or ""
    time24h = now.strftime("%H:%M")

    # 「关于你自己」：名称/身份/年龄一行，性格单独一句
    lines: list[str] = []
    values = [
        str(persona.get("name") or "").strip(),
        str(persona.get("identity") or "").strip(),
        persona.get("age"),
    ]
    parts = [
        tpl.format(v=v)
        for tpl, v in zip(t["parts"], values)
        if v is not None and str(v).strip() != ""
    ]
    if parts:
        lines.append(t["joiner"].join(parts) + t["ender"])
    personality = str(persona.get("personality") or "").strip()
    if personality:
        lines.append(t["personality"].format(v=personality))
    sections = [t["self"] + "\n" + "\n".join(lines)] if lines else []

    prefs = [str(p) for p in (persona.get("preferences") or []) if str(p).strip()]
    if prefs:
        sections.append(
            t["prefs"] + "\n" + "\n".join(f"{i + 1}. {p}" for i, p in enumerate(prefs))
        )

    sections.append(t["lang_line"].format(lang=_LANG_NAMES[lang]))
    sections.append(t["time_line"].format(tz=tz, time24h=time24h))

    if pins:
        sections.append(
            t["mem"] + "\n" + "\n".join(f"{i + 1}. {p}" for i, p in enumerate(pins))
        )

    sections.append(t["tools"])
    sections.append(t["emotion"])
    return "\n\n".join(sections)
