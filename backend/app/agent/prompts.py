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
        "exp_head": (
            "[表情控制]\n"
            "在需要切换表情的位置插入 <exp>名称</exp>，"
            "表情立即切换并持续到本次回复结束。可用表情："
        ),
        "motion_head": (
            "[动作控制]\n"
            "在需要播放动作的位置插入 <motion>组名/序号</motion>，"
            "动作播放一次后回到待机。可用动作："
        ),
        "directive_tail": (
            "指令不会被展示也不会被朗读，清单以外的名称无效；"
            "正文需要输出尖括号时写成 &lt; 或 &gt;。"
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
        "exp_head": (
            "[Expression control]\n"
            "Insert <exp>name</exp> where the expression should change; "
            "it applies immediately and lasts until this reply ends. Available expressions:"
        ),
        "motion_head": (
            "[Motion control]\n"
            "Insert <motion>group/index</motion> where a motion should play; "
            "it plays once, then returns to idle. Available motions:"
        ),
        "directive_tail": (
            "Directives are never displayed or read aloud; names outside the "
            "lists are invalid. Use &lt; or &gt; for literal angle brackets in text."
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
        "exp_head": (
            "[表情コントロール]\n"
            "表情を切り替えたい位置に <exp>名前</exp> を挿入してください。"
            "表情は即座に切り替わり、この返信の終わりまで持続します。利用できる表情："
        ),
        "motion_head": (
            "[モーションコントロール]\n"
            "モーションを再生したい位置に <motion>グループ名/番号</motion> を挿入してください。"
            "一度だけ再生され、その後待機に戻ります。利用できるモーション："
        ),
        "directive_tail": (
            "指令は表示・読み上げされず、リスト外の名前は無効です。"
            "本文で山括弧が必要なときは &lt; や &gt; と書いてください。"
        ),
    },
}


def _lang_of(state: dict[str, Any]) -> str:
    """momo 对话语言：general.chatLang（auto/缺失 → 回落界面语言 lang）。"""
    g = (state.get("settings") or {}).get("general") or {}
    raw = str(g.get("chatLang") or "").lower()
    if not raw or raw == "auto":
        raw = str(g.get("lang") or "zh").lower()
    for code in ("zh", "en", "ja"):
        if raw.startswith(code):
            return code
    return "zh"


def _avatar_resources(state: dict[str, Any]) -> dict[str, Any]:
    """当前形象的资源清单（avatars[] 里按 avatarId 找；缺失 → 空）。"""
    aid = state.get("avatarId") or "builtin"
    for a in state.get("avatars") or []:
        if isinstance(a, dict) and a.get("id") == aid:
            res = a.get("resources")
            return res if isinstance(res, dict) else {}
    return {}


def _resource_lines(items: Any) -> list[str]:
    """资源清单 → "- 名称 — 描述" 行（空名跳过；无描述只列名称）。"""
    lines: list[str] = []
    for r in items or []:
        if not isinstance(r, dict):
            continue
        name = str(r.get("name") or "").strip()
        if not name:
            continue
        desc = str(r.get("desc") or "").strip()
        lines.append(f"- {name} — {desc}" if desc else f"- {name}")
    return lines


def build_system_prompt(state: dict[str, Any]) -> str:
    """按契约模板组装 system prompt；表情/动作段按当前形象资源清单条件注入。"""
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

    # 表情/动作指令段：清单为空的通道整段不注入（同初始记忆的条件规则）。
    res = _avatar_resources(state)
    blocks = [
        head + "\n" + "\n".join(lines)
        for head, lines in (
            (t["exp_head"], _resource_lines(res.get("expressions"))),
            (t["motion_head"], _resource_lines(res.get("motions"))),
        )
        if lines
    ]
    if blocks:
        sections.append("\n\n".join(blocks) + "\n" + t["directive_tail"])

    return "\n\n".join(sections)
