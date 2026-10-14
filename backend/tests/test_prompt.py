"""system prompt 模板：字段注入 + pins + 情绪指令段。"""
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


def test_prompt_emotion_block_present_all_langs():
    tags = "neutral happy sad angry surprised thinking shy sleepy"
    for lang in ("zh", "en", "ja"):
        p = agent.build_system_prompt(_state(lang))
        assert "#tag" in p
        assert tags in p
        # 情绪段必须是最后一段
        assert p.split("\n\n")[-1].startswith("[")
    zh = agent.build_system_prompt(_state("zh"))
    assert "[情绪与动作指令]" in zh


def test_prompt_en_and_ja_templates():
    en = agent.build_system_prompt(_state("en"))
    assert "Your name is momo" in en
    assert "initial memories" in en
    assert "1. 用户的名称是夜羽" in en
    assert "English" in en

    ja = agent.build_system_prompt(_state("ja"))
    assert "あなたの名前はmomo" in ja
    assert "日本語" in ja


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
