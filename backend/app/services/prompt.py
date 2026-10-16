"""system prompt 组装：按对话语言（chatLang，auto→界面语言）选 zh/en/ja，未知回退 zh。"""
from __future__ import annotations

from typing import Any

from ..models import State
from ..core.state import DEFAULT_STATE
from ..core.time import now_info

_LANG_NAMES = {"zh": "中文", "en": "English", "ja": "日本語"}
_DEFAULT_PERSONA: dict[str, Any] = DEFAULT_STATE["persona"]

# 各语言模板片段；{...} 由 builder 注入。结构见 meta/prompt.md：
# # 人格配置（基本信息/偏好/基本设定）→ # 记忆配置（仅初始记忆）→ # 行为配置（表情/动作）
_T = {
    "zh": {
        "persona_head": "# 人格配置",
        "basic_head": "## 你的基本信息",
        "info_lines": (
            "你的名字叫{name}",
            "你的身份是{identity}",
            "你的年龄是{age}",
            "你的性格是{personality}",
        ),
        # 人设字段留空时的出厂回落（与前端 persona.defaults.* 同一份文案）
        "default_identity": "由夜羽开发的AI",
        "default_personality": "乖巧听话",
        "prefs_head": "## 你的偏好",
        "settings_head": "## 你的基本设定",
        "lang_line": "你的对话语言是{lang}，需要使用该语言与用户交流，除非用户要求使用其他语言",
        "time_line": "当前 UTC 时间是{utc}，你所在的时区是{tz}",
        "mem_head": "# 记忆配置",
        "pins_head": "## 你的初始记忆",
        "behavior_head": "# 行为配置",
        "exp_head": "## 表情控制策略",
        "exp_intro": (
            "在需要切换表情的位置插入 <exp>名称</exp>，"
            "表情立即切换并持续到本次回复结束。可用表情："
        ),
        "motion_head": "## 动作控制策略",
        "motion_intro": (
            "在需要播放动作的位置插入 <motion>组名/序号</motion>，"
            "动作播放一次后回到待机。可用动作："
        ),
        "directive_tail": (
            "指令不会被展示也不会被朗读，清单以外的名称无效；"
            "正文需要输出尖括号时写成 &lt; 或 &gt;。"
        ),
    },
    "en": {
        "persona_head": "# Persona Configuration",
        "basic_head": "## Your basic information",
        "info_lines": (
            "Your name is {name}",
            "Your identity is {identity}",
            "You are {age} years old",
            "Your personality is {personality}",
        ),
        # 人设字段留空时的出厂回落（与前端 persona.defaults.* 同一份文案）
        "default_identity": "an AI assistant",
        "default_personality": "sweet and obedient",
        "prefs_head": "## Your preferences",
        "settings_head": "## Your basic settings",
        "lang_line": "Your conversation language is {lang}; talk with the user in that language unless they ask for another one",
        "time_line": "The current UTC time is {utc}; your timezone is {tz}",
        "mem_head": "# Memory Configuration",
        "pins_head": "## Your initial memories",
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
    },
    "ja": {
        "persona_head": "# 人格設定",
        "basic_head": "## あなたの基本情報",
        "info_lines": (
            "あなたの名前は{name}",
            "あなたの身分は{identity}",
            "あなたの年齢は{age}歳",
            "あなたの性格は{personality}",
        ),
        # 人设字段留空时的出厂回落（与前端 persona.defaults.* 同一份文案）
        "default_identity": "夜羽が開発したAI",
        "default_personality": "おとなしくて素直",
        "prefs_head": "## あなたの好み",
        "settings_head": "## あなたの基本設定",
        "lang_line": "あなたの会話言語は{lang}です。ユーザーが他の言語を要求しない限り、その言語で話してください",
        "time_line": "現在の UTC 時刻は{utc}、タイムゾーンは{tz}です",
        "mem_head": "# 記憶設定",
        "pins_head": "## あなたの初期記憶",
        "behavior_head": "# 行動設定",
        "exp_head": "## 表情コントロールポリシー",
        "exp_intro": (
            "表情を切り替えたい位置に <exp>名前</exp> を挿入してください。"
            "表情は即座に切り替わり、この返信の終わりまで持続します。利用できる表情："
        ),
        "motion_head": "## モーションコントロールポリシー",
        "motion_intro": (
            "モーションを再生したい位置に <motion>グループ名/番号</motion> を挿入してください。"
            "一度だけ再生され、その後待機に戻ります。利用できるモーション："
        ),
        "directive_tail": (
            "指令は表示・読み上げされず、リスト外の名前は無効です。"
            "本文で山括弧が必要なときは &lt; や &gt; と書いてください。"
        ),
    },
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
    t = _T[lang]
    # 空字段回落出厂人设：用户在设置里清空=回到初始状态，
    # prompt 侧始终装配默认值（与前端 placeholder 显示同一份文案）。
    # identity/personality 是文案型字段，按当前 prompt 语言取 _T[lang]，
    # 不把某一种语言写死；name/age 与语言无关，仍取 store 默认值。
    persona = dict(state["persona"])
    if not str(persona.get("name") or "").strip():
        persona["name"] = _DEFAULT_PERSONA["name"]
    for key in ("identity", "personality"):
        if not str(persona.get(key) or "").strip():
            persona[key] = t[f"default_{key}"]
    if not isinstance(persona.get("age"), (int, float)) or isinstance(
        persona.get("age"), bool
    ):
        persona["age"] = _DEFAULT_PERSONA["age"]
    # 偏好是列表型配置：空 = 无偏好，不回落默认；装配侧按条件注入（含头）。
    pins = [
        p.strip() for p in (pins or []) if isinstance(p, str) and p.strip()
    ]

    tinfo = now_info()

    sections: list[str] = []

    # # 人格配置：基本信息 / 偏好 / 基本设定
    info = "\n".join(
        "- " + line.format(
            name=str(persona["name"]).strip(),
            identity=str(persona["identity"]).strip(),
            age=persona["age"],
            personality=str(persona["personality"]).strip(),
        )
        for line in t["info_lines"]
    )
    prefs = [str(p).strip() for p in (persona.get("preferences") or []) if str(p).strip()]
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
    if prefs:
        persona_blocks.insert(
            1, t["prefs_head"] + "\n" + "\n".join(f"- {p}" for p in prefs)
        )
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
    if behavior_blocks:
        sections.append(
            t["behavior_head"]
            + "\n\n"
            + "\n\n".join(behavior_blocks)
            + "\n"
            + t["directive_tail"]
        )

    return "\n\n".join(sections)
