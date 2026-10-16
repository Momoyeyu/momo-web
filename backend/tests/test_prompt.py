"""system prompt 组装：字段注入 + pins + 表情/动作指令段（按形象资源清单条件注入）。

模版**只有英文一份**：语言相关的东西只有两处 ——
1. lang_line（值来自设置里的「对话语言」）
2. 人设字段留空时的出厂回落文案（_DEFAULTS，属于「注入内容」）
其余注入内容（人设字段、记忆、资源描述）原样插入，可以是任何语言。
"""

from __future__ import annotations

from app.core import state as store
from app.services import prompt

_PINS = ["用户的名称是夜羽", "夜羽是我的创造者"]


def _state(lang: str, **over):
    return store.normalize_state(
        {
            "settings": {"general": {"lang": lang}},
            "persona": {
                "name": "momo",
                "identity": "AI",
                "age": 16,
                "personality": "乖巧听话",
                "preferences": ["喜欢甜食", "讨厌吵闹"],
            },
            **over,
        }
    )


def _prompt(lang: str, pins=_PINS, **over) -> str:
    return prompt.build_system_prompt(_state(lang, **over), pins)


# ---------------- 模版与语言无关 ----------------


def test_every_template_fragment_is_language_neutral():
    """回归守卫：模版片段里不能出现非拉丁**字母**（即某种语言的措辞）。

    这条是本次设计的底线 —— 谁再往 _T 里塞「## 输出方式」这类本地化措辞就会红。
    标点不限（英文里的破折号、引号本来就不是 ASCII）。按语言变化的只能是
    内容（_DEFAULTS）与语言行。
    """
    fragments: list[str] = []
    for value in prompt._T.values():
        fragments.extend(value if isinstance(value, tuple) else [value])
    assert fragments
    for frag in fragments:
        bad = [ch for ch in frag if ch.isalpha() and not ch.isascii()]
        assert not bad, f"模版片段混入了非拉丁字母（本地化措辞？）：{bad} in {frag!r}"


def test_same_scaffolding_for_every_language():
    """三语的模版骨架完全相同，差异只有 lang_line 那一行。"""
    # 用同一份人设（内容固定），逐语言比对：去掉语言行后应逐字相同
    prompts = {}
    for lang in ("zh", "en", "ja"):
        p = _prompt(lang)
        prompts[lang] = "\n".join(
            line for line in p.split("\n") if "conversation language is" not in line
        )
    assert prompts["zh"] == prompts["en"] == prompts["ja"]


# ---------------- 内容注入 ----------------


def test_fields_and_pins_are_injected_verbatim():
    p = _prompt("zh")
    # 模版是英文
    assert "# Persona Configuration" in p
    assert "## Your basic information" in p
    assert "## Your preferences" in p
    assert "## Your initial memories" in p
    assert "# Memory Configuration" in p
    # 注入的是中文内容（原样插入，模版不参与翻译）
    assert "- Your name is momo" in p
    assert "- Your identity is AI" in p
    assert "- You are 16 years old" in p
    assert "- Your personality is 乖巧听话" in p
    assert "- 喜欢甜食" in p
    assert "- 讨厌吵闹" in p
    assert "- 用户的名称是夜羽" in p
    assert "- 夜羽是我的创造者" in p
    # 使用策略下沉到 tools description；工具清单与策略文本都不写进 prompt
    assert "## 记忆使用策略" not in p
    assert "memory_add" not in p and "common_time" not in p


def test_no_memory_section_when_pins_empty():
    """pins 为空 → 记忆配置整块不出现（使用策略不在模板，仅剩初始记忆段）。"""
    p = _prompt("zh", pins=[])
    assert "# Memory Configuration" not in p
    assert "## Your initial memories" not in p


# ---------------- 语言控制只剩语言行 ----------------


def test_language_line_follows_chat_lang():
    """对话语言的控制点只有语言行；模版本身不随语言变化。"""
    assert "Your conversation language is 中文" in _prompt("zh")
    assert "Your conversation language is English" in _prompt("en")
    assert "Your conversation language is 日本語" in _prompt("ja")


def test_chat_lang_overrides_ui_lang():
    """chatLang 优先于界面语言 lang。"""
    p = _prompt("zh", settings={"general": {"lang": "zh", "chatLang": "ja"}})
    assert "Your conversation language is 日本語" in p

    # auto/缺失 → 回落界面语言
    p2 = _prompt("ja", settings={"general": {"lang": "ja", "chatLang": "auto"}})
    assert "Your conversation language is 日本語" in p2


def test_unknown_lang_falls_back_zh():
    assert "Your conversation language is 中文" in _prompt("fr")


# ---------------- 出厂回落（内容，按语言取） ----------------


def test_empty_persona_falls_back_to_defaults():
    """用户在设置页清空人设字段 → prompt 装配出厂默认值。"""
    p = _prompt(
        "zh",
        persona={
            "name": "",
            "identity": "",
            "age": None,
            "personality": "",
            "preferences": [],
        },
    )
    assert "- Your name is momo" in p
    assert "- Your identity is 由夜羽开发的AI" in p
    assert "- You are 16 years old" in p
    assert "- Your personality is 乖巧听话" in p
    # 偏好是列表型配置：空 = 整段不注入（含头），不回落默认值。
    assert "## Your preferences" not in p


_EMPTY_PERSONA = {
    "name": "",
    "identity": "",
    "age": None,
    "personality": "",
    "preferences": [],
}


def test_content_defaults_follow_language_but_template_does_not():
    """模版恒为英文，只有**内容**（身份/性格回落）随语言变。"""
    ja = _prompt("ja", persona=dict(_EMPTY_PERSONA))
    assert "- Your identity is 夜羽が開発したAI" in ja
    assert "- Your personality is おとなしくて素直" in ja
    assert "由夜羽开发的AI" not in ja

    en = _prompt("en", persona=dict(_EMPTY_PERSONA))
    assert "- Your identity is an AI assistant" in en
    assert "- Your personality is sweet and obedient" in en

    # 三语用的是同一套英文标签
    for p in (ja, en):
        assert "# Persona Configuration" in p
        assert "## Your basic information" in p


def test_content_defaults_follow_chat_lang_not_ui_lang():
    """回落内容跟对话语言（chatLang），不跟界面语言（lang）。"""
    p = _prompt(
        "zh",
        settings={"general": {"lang": "zh", "chatLang": "ja"}},
        persona=dict(_EMPTY_PERSONA),
    )
    assert "- Your identity is 夜羽が開発したAI" in p
    assert "由夜羽开发的AI" not in p


def test_name_and_age_defaults_are_language_independent():
    """name/age 与语言无关：三语都回落 momo / 16，且标签相同。"""
    for lang in ("zh", "en", "ja"):
        p = _prompt(lang, persona=dict(_EMPTY_PERSONA))
        assert "- Your name is momo" in p
        assert "- You are 16 years old" in p


# ---------------- 行为配置（指令段） ----------------


def test_directive_section_without_expressions():
    """默认内置形象（Hiyori：无表情、10 个动作）→ 只注入动作段。"""
    for lang in ("zh", "en", "ja"):
        p = _prompt(lang)
        assert "<motion>" in p and "Idle/4" in p
        assert "<exp>" not in p  # Hiyori 无表情文件 → 表情段不注入
        # 行为配置是最后一节，末尾是动作控制小节 + 容错说明
        assert p.split("\n\n")[-1].startswith("##")

    p = _prompt("zh")
    assert "# Behavior Configuration" in p
    assert "## Motion control policy" in p
    assert "## Expression control policy" not in p
    assert "- Idle/4 — 思考的样子" in p  # 资源描述是注入内容，保持原语言
    assert "&lt;" in p


def test_directive_section_with_expressions():
    """导入模型带表情资源 → 表情段注入，名称-描述成行。"""
    p = _prompt(
        "zh",
        avatarId="av_x",
        avatars=[
            {
                "id": "av_x",
                "resources": {
                    "expressions": [
                        {"name": "star_eyes", "desc": "非常期待"},
                        {"name": "fukidashi", "desc": ""},
                    ],
                    "motions": [{"name": "Tap/0", "desc": ""}],
                },
            }
        ],
    )
    assert "## Expression control policy" in p
    assert "- star_eyes — 非常期待" in p
    assert "- fukidashi" in p and "fukidashi —" not in p
    assert "## Motion control policy" in p and "- Tap/0" in p


def test_no_directive_section_when_no_resources():
    """当前形象没有资源清单 → 整个行为配置节不出现。"""
    p = _prompt("zh", avatarId="av_x", avatars=[{"id": "av_x"}])
    assert "<exp>" not in p and "<motion>" not in p
    assert "# Behavior Configuration" not in p


# ---------------- 输出方式 ----------------


def test_output_style_section_present_for_every_language():
    """一轮可多次输出 + 工具调用前先说明：模版只有一份，三语因此都拿到它。

    这几条直接决定前端「逐句可见/逐句朗读」的观感，缺一条模型就可能整段吐。
    """
    for lang in ("zh", "en", "ja"):
        p = _prompt(lang)
        assert "## How you speak" in p
        assert "several separate outputs" in p
        assert "empty content" in p
