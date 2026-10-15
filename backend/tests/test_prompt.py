"""system prompt 模板：字段注入 + pins + 表情/动作指令段（按形象资源清单条件注入）。"""
from __future__ import annotations

from app import agent, store


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
            "pins": ["用户的名称是夜羽", "夜羽是我的创造者"],
            **over,
        }
    )


def test_prompt_zh_fields_injected():
    p = agent.build_system_prompt(_state("zh"))
    assert "你的名字叫momo" in p
    assert "你的身份是AI" in p
    assert "你的年龄是16" in p
    assert "你的性格是乖巧听话" in p
    assert "1. 喜欢草莓蛋糕" in p
    assert "你的主语言是中文" in p
    # pins 进入初始记忆段
    assert "1. 用户的名称是夜羽" in p
    assert "2. 夜羽是我的创造者" in p
    # 工具列表
    assert "1. memory_add" in p and "5. common_time" in p


def test_prompt_directive_sections_all_langs():
    """默认内置形象（Hiyori：无表情、10 个动作）→ 只注入动作段。"""
    for lang in ("zh", "en", "ja"):
        p = agent.build_system_prompt(_state(lang))
        assert "<motion>" in p and "Idle/4" in p
        assert "<exp>" not in p  # Hiyori 无表情文件 → 表情段不注入
        # 指令段必须是最后一段且以容错说明收尾
        assert p.split("\n\n")[-1].startswith("[")
    zh = agent.build_system_prompt(_state("zh"))
    assert "[动作控制]" in zh
    assert "- Idle/4 — 思考的样子" in zh
    assert "&lt;" in zh


def test_prompt_directive_sections_with_expressions():
    """导入模型带表情资源 → 表情段注入，名称-描述成行。"""
    p = agent.build_system_prompt(
        _state(
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
    )
    assert "[表情控制]" in p
    assert "- star_eyes — 非常期待" in p
    assert "- fukidashi" in p and "fukidashi —" not in p
    assert "[动作控制]" in p and "- Tap/0" in p


def test_prompt_no_directive_section_when_no_resources():
    """当前形象没有资源清单 → 整个指令段不出现。"""
    p = agent.build_system_prompt(
        _state("zh", avatarId="av_x", avatars=[{"id": "av_x"}])
    )
    assert "<exp>" not in p and "<motion>" not in p
    assert "[动作控制]" not in p


def test_prompt_en_and_ja_templates():
    en = agent.build_system_prompt(_state("en"))
    assert "Your name is momo" in en
    assert "initial memories" in en
    assert "1. 用户的名称是夜羽" in en
    assert "English" in en

    ja = agent.build_system_prompt(_state("ja"))
    assert "あなたの名前はmomo" in ja
    assert "日本語" in ja


def test_prompt_chat_lang_overrides_ui_lang():
    """对话语言独立于界面语言：chatLang=ja + lang=zh → ja 模板。"""
    p = agent.build_system_prompt(
        _state("zh", settings={"general": {"lang": "zh", "chatLang": "ja"}})
    )
    assert "あなたの名前はmomo" in p
    assert "日本語" in p

    # auto/缺失 → 回落界面语言
    p2 = agent.build_system_prompt(
        _state("ja", settings={"general": {"lang": "ja", "chatLang": "auto"}})
    )
    assert "あなたの名前はmomo" in p2


def test_prompt_unknown_lang_falls_back_zh():
    p = agent.build_system_prompt(_state("fr"))
    assert "你的名字叫momo" in p


def test_prompt_empty_persona_falls_back_defaults():
    """用户在设置页清空人设字段 → prompt 装配出厂默认值。"""
    p = agent.build_system_prompt(
        _state(
            "zh",
            persona={
                "name": "",
                "identity": "",
                "age": None,
                "personality": "",
                "preferences": [],
            },
        )
    )
    assert "你的名字叫momo" in p
    assert "你的身份是AI" in p
    assert "你的年龄是16" in p
    assert "你的性格是乖巧听话" in p
    assert "1. 喜欢草莓蛋糕" in p
