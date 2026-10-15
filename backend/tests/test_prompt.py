"""system prompt 模板：字段注入 + pins + 表情/动作指令段（按形象资源清单条件注入）。"""
from __future__ import annotations

from app import agent, store

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
                "preferences": ["喜欢草莓蛋糕", "讨厌苦的东西"],
            },
            **over,
        }
    )


def _prompt(lang: str, pins=_PINS, **over) -> str:
    return agent.build_system_prompt(_state(lang, **over), pins)


def test_prompt_zh_fields_injected():
    p = _prompt("zh")
    assert "# 人格配置" in p and "## 你的基本信息" in p
    assert "- 你的名字叫momo" in p
    assert "- 你的身份是AI" in p
    assert "- 你的年龄是16" in p
    assert "- 你的性格是乖巧听话" in p
    assert "## 你的偏好" in p
    assert "- 喜欢草莓蛋糕" in p
    assert "- 讨厌苦的东西" in p
    assert "- 你的对话语言是中文" in p
    # pins 进入初始记忆段
    assert "## 你的初始记忆" in p
    assert "- 用户的名称是夜羽" in p
    assert "- 夜羽是我的创造者" in p
    # 使用策略下沉到 tools description；工具清单与策略文本都不写进 prompt
    assert "## 记忆使用策略" not in p
    assert "memory_add" not in p and "common_time" not in p


def test_prompt_no_memory_section_when_pins_empty():
    """pins 为空 → 记忆配置整块不出现（使用策略不在模板，仅剩初始记忆段）。"""
    p = _prompt("zh", pins=[])
    assert "# 记忆配置" not in p
    assert "## 你的初始记忆" not in p


def test_prompt_directive_sections_all_langs():
    """默认内置形象（Hiyori：无表情、10 个动作）→ 只注入动作段。"""
    for lang in ("zh", "en", "ja"):
        p = _prompt(lang)
        assert "<motion>" in p and "Idle/4" in p
        assert "<exp>" not in p  # Hiyori 无表情文件 → 表情段不注入
        # 行为配置是最后一节，末尾是动作控制小节 + 容错说明
        assert p.split("\n\n")[-1].startswith("##")
    zh = _prompt("zh")
    assert "# 行为配置" in zh
    assert "## 动作控制策略" in zh
    assert "## 表情控制策略" not in zh
    assert "- Idle/4 — 思考的样子" in zh
    assert "&lt;" in zh


def test_prompt_directive_sections_with_expressions():
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
    assert "## 表情控制策略" in p
    assert "- star_eyes — 非常期待" in p
    assert "- fukidashi" in p and "fukidashi —" not in p
    assert "## 动作控制策略" in p and "- Tap/0" in p


def test_prompt_no_directive_section_when_no_resources():
    """当前形象没有资源清单 → 整个行为配置节不出现。"""
    p = _prompt("zh", avatarId="av_x", avatars=[{"id": "av_x"}])
    assert "<exp>" not in p and "<motion>" not in p
    assert "# 行为配置" not in p


def test_prompt_en_and_ja_templates():
    en = _prompt("en")
    assert "Your name is momo" in en
    assert "## Your initial memories" in en
    assert "- 用户的名称是夜羽" in en
    assert "English" in en

    ja = _prompt("ja")
    assert "あなたの名前はmomo" in ja
    assert "日本語" in ja


def test_prompt_chat_lang_overrides_ui_lang():
    """对话语言独立于界面语言：chatLang=ja + lang=zh → ja 模板。"""
    p = _prompt(
        "zh", settings={"general": {"lang": "zh", "chatLang": "ja"}}
    )
    assert "あなたの名前はmomo" in p
    assert "日本語" in p

    # auto/缺失 → 回落界面语言
    p2 = _prompt(
        "ja", settings={"general": {"lang": "ja", "chatLang": "auto"}}
    )
    assert "あなたの名前はmomo" in p2


def test_prompt_unknown_lang_falls_back_zh():
    p = _prompt("fr")
    assert "你的名字叫momo" in p


def test_prompt_empty_persona_falls_back_defaults():
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
    assert "你的名字叫momo" in p
    assert "你的身份是由夜羽开发的AI" in p
    assert "你的年龄是16" in p
    assert "你的性格是乖巧听话" in p
    # 偏好是列表型配置：空 = 整段不注入（含头），不回落默认值。
    assert "## 你的偏好" not in p
