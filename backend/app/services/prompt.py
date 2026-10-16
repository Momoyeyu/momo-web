"""system prompt 组装。

模版**只有英文一份**（见 _T），对语言不敏感 —— 三种语言各维护一套模版既难同步、
也没有证据表明效果更好。

会随语言变化的只有两处：
1. lang_line：值来自设置里的「对话语言」（chatLang，auto → 界面语言，未知回退 zh）
2. 人设字段留空时的出厂回落（_DEFAULTS）—— 那是**内容**，不是模版措辞

其余注入内容（人设字段、记忆、形象资源描述）原样插入模版，可以是任何语言。
"""
from __future__ import annotations

from typing import Any

from ..models import State
from ..core.time import now_info

_LANG_NAMES = {"zh": "中文", "en": "English", "ja": "日本語"}
#: 出厂人设：**写死**。设置页没有对应入口，用户改不到 ——
#: 要改人设就改这里（这是唯一入口）。
PERSONA: dict[str, Any] = {
    "name": "momo",
    "age": 16,
    "identity": "人工智能",
    "personality": "乖巧听话",
}

# 段落顺序：人格配置（基本信息/偏好/基本设定）→ 记忆配置（仅初始记忆）
# → 输出方式 → 行为配置（表情/动作）。{...} 由 builder 注入。
# 提示词模版：**只有英文一份**。
#
# 为什么不按语言各写一套：三套模版要一直同步（改一处就得记得改另两处），
# 且没有证据表明「用目标语言写的模版」效果更好。模版本身对语言不敏感，
# 对话语言只由 lang_line 控制（值来自设置里的「对话语言」）。
#
# 需要随语言变化的只有**注入内容**（人设字段、记忆、资源描述）——
# 它们原样插入模版占位符，可以是任何语言，不需要模版配合。
_T: dict[str, Any] = {
    "persona_head": "# Persona Configuration",
    "basic_head": "## Your basic information",
    "info_lines": (
        "Your name is {name}",
        "Your identity is {identity}",
        "You are {age} years old",
        "Your personality is {personality}",
    ),
    "settings_head": "## Your basic settings",
    "lang_line": (
        "Your conversation language is {lang}; talk with the user in that "
        "language unless they ask for another one"
    ),
    "time_line": "The current UTC time is {utc}; your timezone is {tz}",
    "mem_head": "# Memory Configuration",
    "pins_head": "## Your initial memories",
    "output_head": "## How you speak",
    "output_lines": (
        "You may speak in several separate outputs within one reply: say one "
        "thing at a time, one or two sentences per output",
        "When you need a tool, first say in one sentence what you are about to "
        "do, then call it — that line is shown and spoken to the user right away",
        "Every output must be a complete, speakable sentence. Never dump a whole "
        "paragraph at once, and never output empty content",
    ),
    "behavior_head": "# Behavior Configuration",
    "exp_head": "## Expression control policy",
    "exp_intro": (
        "Insert <exp>name</exp> where the expression should change; "
        "it applies immediately and lasts until this reply ends. Available expressions:"
    ),
    "motion_head": "## Motion control policy",
    "motion_intro": (
        "Insert <motion>group/index</motion> where a motion should play; "
        "it plays once, then returns to idle. Available motions:"
    ),
    "directive_tail": (
        "Directives are never displayed or read aloud; names outside the "
        "lists are invalid. Use &lt; or &gt; for literal angle brackets in text."
    ),
}


def _lang_of(state: State) -> str:
    """momo 对话语言：general.chatLang（auto/缺失 → 回落界面语言 lang）。"""
    g = state["settings"]["general"]
    raw = str(g["chatLang"] or "").lower()
    if not raw or raw == "auto":
        raw = str(g["lang"] or "zh").lower()
    for code in ("zh", "en", "ja"):
        if raw.startswith(code):
            return code
    return "zh"


def _avatar_resources(state: State) -> dict[str, Any]:
    """当前形象的资源清单（avatars[] 里按 avatarId 找；缺失 → 空）。

    返回值保持 dict[str, Any]：resources 来自 momo.yaml，可能是任意形状，
    故仍做 isinstance 兜底（这是真防御，不是死代码）。
    """
    aid = state["avatarId"] or "builtin"
    for a in state["avatars"]:
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


def build_system_prompt(
    state: State, pins: list[str] | None = None
) -> str:
    """按契约模板组装 system prompt；初始记忆/表情/动作段按条件注入。

    state：必须是 store.normalize_state() 的产物——字段存在性由该边界保证，
    本函数因此直接下标访问，不再做防御式下钻。
    pins：初始记忆文本列表（momo.db memories.pinned=1；由调用方注入，
    state 里已不含 pin 数据）。
    """
    lang = _lang_of(state)
    t = _T  # 模版只有一份（英文），不再按语言取
    # 人设写死（见 PERSONA）：不从配置读，用户也没有入口改。
    persona = PERSONA
    # 初始记忆（pins）由调用方注入（momo.db 里 pinned=1 的行）。
    pins = [
        p.strip() for p in (pins or []) if isinstance(p, str) and p.strip()
    ]

    tinfo = now_info()

    sections: list[str] = []

    # # 人格配置：基本信息 / 基本设定
    info = "\n".join(
        "- " + line.format(
            name=str(persona["name"]).strip(),
            identity=str(persona["identity"]).strip(),
            age=persona["age"],
            personality=str(persona["personality"]).strip(),
        )
        for line in t["info_lines"]
    )
    settings = "\n".join(
        "- " + line
        for line in (
            t["lang_line"].format(lang=_LANG_NAMES[lang]),
            t["time_line"].format(utc=tinfo["utc"], tz=tinfo["tz"]),
        )
    )
    # 偏好条件注入（含头）：空列表 = 无偏好，整段不出现，不留空标题。
    persona_blocks = [
        t["persona_head"] + "\n\n" + t["basic_head"] + "\n" + info,
        t["settings_head"] + "\n" + settings,
    ]
    sections.append("\n\n".join(persona_blocks))

    # # 记忆配置：仅初始记忆；pins 为空时整块不出现。
    # 使用策略已下沉到各能力的 tools description（见 capability.py），不进提示词。
    if pins:
        sections.append(
            t["mem_head"]
            + "\n\n"
            + t["pins_head"]
            + "\n"
            + "\n".join(f"- {p}" for p in pins)
        )

    # # 行为配置：清单为空的通道整段不注入；两通道都无资源则整节不出现。
    res = _avatar_resources(state)
    behavior_blocks = [
        head + "\n" + intro + "\n" + "\n".join(lines)
        for head, intro, lines in (
            (t["exp_head"], t["exp_intro"], _resource_lines(res.get("expressions"))),
            (t["motion_head"], t["motion_intro"], _resource_lines(res.get("motions"))),
        )
        if lines
    ]
    # 输出方式：恒定注入（与形象资源无关）——一轮可多次输出、工具调用前先说明，
    # 直接决定前端「逐句可见/逐句朗读」的观感。
    sections.append(
        t["output_head"] + "\n" + "\n".join(f"- {line}" for line in t["output_lines"])
    )

    if behavior_blocks:
        sections.append(
            t["behavior_head"]
            + "\n\n"
            + "\n\n".join(behavior_blocks)
            + "\n"
            + t["directive_tail"]
        )

    return "\n\n".join(sections)
