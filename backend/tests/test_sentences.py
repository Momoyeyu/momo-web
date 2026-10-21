"""切句器单测：边界口径、引号保护、指令原子性、流式一致性。

"""

from __future__ import annotations

import random

import pytest

from app.core.sentences import SentenceStream, split_sentences


def texts(sents) -> list[str]:
    return [s.text for s in sents]


# ---------------- 强边界 ----------------


def test_strong_boundary_splits_chinese():
    assert texts(split_sentences("你好。再见！")) == ["你好。", "再见！"]


def test_ascii_period_splits_english():
    assert texts(split_sentences("Hello there. How are you?")) == [
        "Hello there.",
        "How are you?",
    ]


def test_decimal_point_is_not_a_boundary():
    assert texts(split_sentences("圆周率约 3.14 左右。")) == ["圆周率约 3.14 左右。"]


def test_newline_is_a_strong_boundary():
    assert texts(split_sentences("第一行\n第二行")) == ["第一行", "第二行"]


# ---------------- 弱边界：只在「这句太长了」时才断 ----------------


def test_weak_boundary_ignored_while_short():
    """「我……不知道」不该被切开 —— 这正是「拆得太细」的典型。"""
    assert texts(split_sentences("我……不知道。")) == ["我……不知道。"]


def test_short_comma_sentence_stays_whole():
    assert texts(split_sentences("今天天气不错，我们出去走走吧。")) == [
        "今天天气不错，我们出去走走吧。"
    ]


def test_weak_boundary_used_as_safety_valve_when_long():
    long_head = "这是一句很长很长的开场白用来把长度顶过阈值" * 3  # 63 字 > 阈值
    sents = split_sentences(f"{long_head}，然后才是后半句。")
    assert len(sents) == 2
    assert sents[0].text.endswith("，")
    assert sents[1].text == "然后才是后半句。"


# ---------------- 不拆区 ----------------


def test_weak_boundary_disabled_inside_quotes():
    """引号内的长逗号不断句：同样长度放在引号外会断作对照。"""
    inner = "这是一段被引号包住的很长很长的话" * 4  # 64 字 > 阈值
    assert len(split_sentences(f"{inner}，还在外面。")) == 2      # 对照组：会断
    assert len(split_sentences(f"「{inner}，还在引号里」结束。")) == 1  # 引号内不断


def test_weak_boundary_disabled_inside_action_marker():
    """*…* 动作标注内部同样不断句（成对符号的开闭态）。"""
    inner = "她轻轻叹了口气动作标注里的内容也很长" * 4  # 72 字 > 阈值
    assert len(split_sentences(f"{inner}，还在外面。")) == 2   # 对照组
    assert len(split_sentences(f"*{inner}，还在里面*结束。")) == 1


# ---------------- 连写标点 ----------------


def test_consecutive_strong_punctuation_merges_into_previous():
    assert texts(split_sentences("真的吗？！我不信。")) == ["真的吗？！", "我不信。"]


def test_ellipsis_run_merges_into_previous():
    assert texts(split_sentences("你怎么能这样……算了。")) == [
        "你怎么能这样……算了。"
    ]


# ---------------- 硬上限 ----------------


def test_hard_max_len_force_splits():
    sents = split_sentences("啊" * 450)
    assert [len(s.text) for s in sents] == [200, 200, 50]


# ---------------- 指令原子性 ----------------


def test_control_after_sentence_belongs_to_next():
    sents = split_sentences('你好。<|ACT {"expression":{"name":"happy"}}|>再见。')
    assert texts(sents) == ["你好。", "再见。"]
    assert sents[0].cues == []
    assert sents[1].cues[0].offset == 0
    assert sents[1].cues[0].payload['expression']['name'] == 'happy'


def test_control_inside_sentence_keeps_offset():
    sents = split_sentences('前半<|ACT {"expression":{"name":"happy"}}|>后半。')
    assert texts(sents) == ["前半后半。"]
    assert sents[0].cues[0].offset == 2


def test_motion_control_is_atomic():
    sents = split_sentences('<|ACT {"motion":"a,b/1"}|>完成。')
    assert texts(sents) == ['完成。']
    assert sents[0].cues[0].payload == {'motion': 'a,b/1'}


def test_malformed_control_is_not_spoken():
    sents = split_sentences('前面<|ACT 未闭合')
    assert texts(sents) == ['前面']
    assert sents[0].cues == []


def test_stray_angle_bracket_is_literal():
    sents = split_sentences("a < b 是个比较。")
    assert texts(sents) == ["a < b 是个比较。"]


# ---------------- 流式一致性（最关键的性质） ----------------


CASES = [
    "你好。今天过得怎么样？有想聊的事尽管告诉我哦。",
    "Hello there. How are you? Fine, thanks!",
    "我……不知道。也许吧，你说呢？",
    "「引号里的话，很长很长很长很长很长很长很长很长很长很长很长」然后结束。",
    '前半<|ACT {"expression":{"name":"happy"}}|>后半。<|ACT {"motion":"wave/0"}|>挥手。',
    "没有标点的尾巴",
    "真的吗？！我不信。",
    "圆周率约 3.14 左右，够用。",
]


def stream_with(text: str, size: int) -> list[str]:
    st = SentenceStream()
    out = []
    for i in range(0, len(text), size):
        out.extend(st.push(text[i : i + size]))
    out.extend(st.flush())
    return [s.text for s in out]


@pytest.mark.parametrize("case", CASES)
def test_streaming_chunking_invariance(case: str):
    """按任意粒度分片喂入，结果必须与整段一致 —— 流式切句的正确性底线。"""
    whole = texts(split_sentences(case))
    for size in (1, 2, 3, 5, 7, 13):
        assert stream_with(case, size) == whole, f"分片 {size} 与整段不一致"


@pytest.mark.parametrize("case", CASES)
def test_streaming_random_chunking_invariance(case: str):
    """随机分片同样一致（模拟真实 token 到达节奏）。"""
    whole = texts(split_sentences(case))
    rnd = random.Random(20261016)
    for _ in range(12):
        st = SentenceStream()
        out = []
        i = 0
        while i < len(case):
            n = rnd.randint(1, 4)
            out.extend(st.push(case[i : i + n]))
            i += n
        out.extend(st.flush())
        assert [s.text for s in out] == whole


def test_flush_emits_tail():
    st = SentenceStream()
    assert st.push("没有标点的尾巴") == []
    assert texts(st.flush()) == ["没有标点的尾巴"]
    assert st.flush() == []


def test_push_empty_is_noop():
    st = SentenceStream()
    assert st.push("") == []
    assert st.flush() == []
