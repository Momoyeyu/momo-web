"""ReAct 循环 + 工具执行 + system prompt 组装。

run_turn(text) 是生成器：yield SSE 事件 dict（delta/error）。
history 由本模块在回合结束时追加并落盘（cap 100）。
prompt 模板按 settings.general.lang 选 zh/en/ja（未知语言回退 zh）。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Iterator

from . import llm, memory, store

MAX_ROUNDS = 5
HISTORY_WINDOW = 20

# OpenAI function calling 工具声明
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "memory.add",
            "description": "新增一条普通记忆（关于用户或对话的重要事实）",
            "parameters": {
                "type": "object",
                "properties": {"content": {"type": "string"}},
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory.search",
            "description": "搜索相关记忆，返回 [{id, content}]",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memory.delete",
            "description": "删除一条普通记忆（初始记忆 pin 不可删除）",
            "parameters": {
                "type": "object",
                "properties": {"id": {"type": "string"}},
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "common.time",
            "description": "获取 backend 本机当前时间",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

_DELTA_DELIMS = "。！？!?…\n"


# ---------- system prompt ----------

_LANG_NAMES = {"zh": "中文", "en": "English", "ja": "日本語"}

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
        "tools": "你有以下工具：\n1. memory.add\n2. memory.search\n3. memory.delete\n4. common.time",
        "extra": {
            "oneLiner": "一句话简介",
            "likes": "你喜欢",
            "dislikes": "你讨厌",
            "traits": "你的特点",
            "tone": "你的语气",
            "taboos": "你的禁忌",
            "examples": "对话例子",
        },
        "user_label": "用户",
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
        "tools": "You have the following tools:\n1. memory.add\n2. memory.search\n3. memory.delete\n4. common.time",
        "extra": {
            "oneLiner": "One-liner",
            "likes": "You like",
            "dislikes": "You dislike",
            "traits": "Your traits",
            "tone": "Your tone",
            "taboos": "Your taboos",
            "examples": "Dialogue examples",
        },
        "user_label": "User",
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
        "tools": "あなたは以下のツールを使えます：\n1. memory.add\n2. memory.search\n3. memory.delete\n4. common.time",
        "extra": {
            "oneLiner": "ひとこと",
            "likes": "あなたの好きなもの",
            "dislikes": "あなたの嫌いなもの",
            "traits": "あなたの特徴",
            "tone": "あなたの口調",
            "taboos": "あなたの禁忌",
            "examples": "会話例",
        },
        "user_label": "ユーザー",
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

# 契约外但前端 persona card 可能携带的扩展字段，非空时并入「关于你自己」
_EXTRA_ORDER = ["oneLiner", "likes", "dislikes", "traits", "tone", "taboos", "examples"]


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
    persona = state.get("persona") or {}
    pins = [p for p in (state.get("pins") or []) if isinstance(p, str)]

    now = datetime.now().astimezone()
    tz = now.tzname() or ""
    time24h = now.strftime("%H:%M")

    # 「关于你自己」：契约字段 + 扩展 persona 字段（空则跳过）
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
    for key in _EXTRA_ORDER:
        v = persona.get(key)
        label = t["extra"][key]
        if key == "examples" and isinstance(v, list) and v:
            name = values[0] or "momo"
            ex = "\n\n".join(
                f'{t["user_label"]}：{e.get("user", "")}\n{name}：{e.get("assistant", "")}'
                for e in v
                if isinstance(e, dict)
            )
            if ex:
                lines.append(f"{label}：\n{ex}")
        elif isinstance(v, list) and v:
            items = "\n".join(f"- {s}" for s in v if str(s).strip())
            if items:
                lines.append(f"{label}：\n{items}")
        elif isinstance(v, str) and v.strip():
            lines.append(f"{label}：{v.strip()}")
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


# ---------- 工具执行 ----------

def _execute_tool(name: str, args: dict[str, Any], pins: list[str]) -> str:
    """执行单个 tool call，返回字符串化结果（不向上抛）。"""
    try:
        if name == "memory.add":
            mem = memory.add_memory(str(args.get("content") or ""), pins=pins)
            return json.dumps({"ok": True, "id": mem["id"]}, ensure_ascii=False)
        if name == "memory.search":
            res = memory.search_memories(str(args.get("query") or ""), pins=pins)
            return json.dumps(res, ensure_ascii=False)
        if name == "memory.delete":
            memory.delete_memory(str(args.get("id") or ""))
            return json.dumps({"ok": True}, ensure_ascii=False)
        if name == "common.time":
            now = datetime.now().astimezone()
            return json.dumps(
                {"iso": now.isoformat(timespec="seconds"), "tz": now.tzname() or ""},
                ensure_ascii=False,
            )
        return f"未知工具：{name}"
    except memory.MemoryError as e:
        return str(e)  # 校验/去重/不可删 → 说明文本回给模型
    except Exception as e:
        return f"工具执行失败：{e}"


def _run_call(call: dict[str, Any], pins: list[str]) -> dict[str, Any]:
    fn = call.get("function") or {}
    name = str(fn.get("name") or "")
    raw_args = fn.get("arguments") or "{}"
    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else dict(raw_args)
        if not isinstance(args, dict):
            args = {}
    except Exception:
        return {
            "role": "tool",
            "tool_call_id": call.get("id") or "",
            "content": "工具参数解析失败",
        }
    return {
        "role": "tool",
        "tool_call_id": call.get("id") or "",
        "content": _execute_tool(name, args, pins),
    }


# ---------- 文本切段 ----------

def split_segments(text: str) -> list[str]:
    """按标点（。！？!?…\\n）切段，保留标点；无标点时整段返回。"""
    segs: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in _DELTA_DELIMS:
            segs.append(buf)
            buf = ""
    if buf:
        segs.append(buf)
    return segs or [text]


# ---------- ReAct 主循环 ----------

def run_turn(text: str) -> Iterator[dict[str, Any]]:
    """一回合：yield {"t":"delta",...} 或 {"t":"error",...}（结束即返回）。

    无 tool_calls 的 content 切段作为 delta；5 轮仍无 content → error。
    """
    state = store.normalize_state(store.read_state())
    pins = [p for p in (state.get("pins") or []) if isinstance(p, str)]
    llm_cfg = (state.get("settings") or {}).get("llm") or {}

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": build_system_prompt(state)}
    ]
    for h in (state.get("history") or [])[-HISTORY_WINDOW:]:
        role = h.get("role")
        if role in ("user", "assistant"):
            messages.append({"role": role, "content": str(h.get("text") or "")})
    messages.append({"role": "user", "content": text})

    content = ""
    for _ in range(MAX_ROUNDS):
        try:
            msg = llm.chat_completion(llm_cfg, messages, tools=TOOLS)
        except llm.LlmError as e:
            yield {"t": "error", "message": str(e), "service": "llm"}
            return

        tool_calls = msg.get("tool_calls") or []
        if tool_calls:
            messages.append(msg)  # assistant（含 tool_calls）原样回传
            for call in tool_calls:
                messages.append(_run_call(call, pins))
            continue

        content = str(msg.get("content") or "")
        if content.strip():
            break
        # 空 content 且无 tool_calls：记一轮，继续重试
    else:
        yield {
            "t": "error",
            "message": "llm produced no response within 5 rounds",
            "service": "llm",
        }
        return

    # 回合结束：user/assistant 追加进 history（cap 100）并落盘，再推流
    at = datetime.now(timezone.utc).isoformat()
    store.append_history(
        [
            {"role": "user", "text": text, "at": at},
            {"role": "assistant", "text": content, "at": at},
        ]
    )
    for seg in split_segments(content):
        yield {"t": "delta", "text": seg}
