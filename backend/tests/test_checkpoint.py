"""Continuous history: display acknowledgements, interruption and projection."""

from __future__ import annotations


import pytest


from fastapi.testclient import TestClient


from app.core import llm


from app.core import db


from app.services import checkpoint, turn


from app.services import compress


from app.main import app


from conftest import add_turn


def _seed(turns: int, prefix: str = "") -> None:
    """往当前会话追加 turns 个完整回合。"""
    for i in range(turns):
        add_turn(f"{prefix}问{i}", f"{prefix}答{i}", at=f"{prefix}t{i}")


def _live_texts() -> list[str]:
    return [m["text"] for m in checkpoint.live_messages()]


def _set_summary(text: str) -> None:
    with db.tx() as c:
        c.execute(
            "UPDATE sessions SET summary=? WHERE id=?",
            (text, db.LIVE_ID),
        )


def _live_summary() -> str:
    return checkpoint.live_summary()


class _InlineThread:
    """测试用线程替身：start() 同步执行，压缩在调用栈内即刻完成。"""

    def __init__(self, target=None, daemon=None, **kw):
        self._target = target

    def start(self):
        if self._target:
            self._target()


def _fake_completion(content="好。", prompt_tokens=0):
    """llm.chat_completion 替身：压缩摘要走非流式这条路径。"""

    def fake(llm_cfg, messages, tools=None, usage_out=None, **kwargs):
        if usage_out is not None:
            usage_out.update({"prompt_tokens": prompt_tokens})
        return {"role": "assistant", "content": content}

    return fake


def _fake_chat(content="好。", prompt_tokens=0):
    def fake(llm_cfg, messages, tools=None, usage_out=None, **kwargs):
        if usage_out is not None:
            usage_out.update({"prompt_tokens": prompt_tokens})
        yield {"type": "text", "delta": content}

    return fake


def test_live_transcript_endpoint():
    client = TestClient(app)
    _seed(1, "甲")
    r = client.get("/api/checkpoints/live")
    assert r.status_code == 200
    body = r.json()
    assert [m["text"] for m in body["messages"]] == ["甲问0", "甲答0"]
    # live 不出现在存档列表里
    assert client.get("/api/checkpoints").json() == []


def test_interrupt_truncates_committed_reply():
    """回复已落账后打断：assistant 行截到用户看到的部分。"""
    add_turn("在吗", "很长很长的完整回复")
    checkpoint.interrupt_turn("在吗", "很长")
    assert _live_texts() == ["在吗", "很长"]


def test_interrupt_empty_display_deletes_reply():
    """打断时一个字都没看到：assistant 行删除，保留 user。"""
    add_turn("在吗", "完整回复")
    checkpoint.interrupt_turn("在吗", "")
    assert _live_texts() == []


def test_interrupt_kills_pending_landing():
    """打断先于回复落账：代际 +1 使在途 append_sentence 作废。"""
    gen = checkpoint.generation()
    assert checkpoint.begin_turn("在吗", gen, "t")
    checkpoint.interrupt_turn("在吗", "")
    assert checkpoint.append_sentence("完整回复", gen, "t") is False
    assert _live_texts() == []  # 回复没落库


def test_interrupt_pending_with_seen_text():
    """打断在生成中且用户已看到部分文本：user 已落账 → 补写看到的部分。"""
    gen = checkpoint.generation()
    assert checkpoint.begin_turn("在吗", gen, "t")
    checkpoint.interrupt_turn("在吗", "看到了一半")
    assert checkpoint.append_sentence("完整回复", gen, "t") is False
    assert _live_texts() == ["在吗", "看到了一半"]


def test_interrupt_turn_never_reached_backend():
    """SSE 没到 backend 就被打断：尾对不匹配 → 按所见补写整对。"""
    _seed(1, "旧")
    checkpoint.interrupt_turn("新问", "看到一点")
    assert _live_texts() == ["旧问0", "旧答0", "新问", "看到一点"]


def _add_multi_turn(user: str, sentences: list[str], at: str = "t") -> None:
    """落一个**多句**回合：句级落账下每句一行。

    单句回合（add_turn）测不到对齐逻辑 —— 本回合只有一行 assistant 时，
    「最后两行」刚好是 [assistant, user]，看不出取行的边界错误。
    """
    gen = checkpoint.generation()
    assert checkpoint.begin_turn(user, gen, at)
    for sentence in sentences:
        assert checkpoint.append_sentence(sentence, gen, at)
    checkpoint.acknowledge(checkpoint.current_run(gen, at), "".join(sentences), gen)


def test_interrupt_multi_sentence_seen_all():
    """多句回合、用户看全：行原样保留，且不得重复插 user 行。"""
    _add_multi_turn("在吗", ["第一句。", "第二句。"])
    checkpoint.interrupt_turn("在吗", "第一句。第二句。")
    assert _live_texts() == ["在吗", "第一句。", "第二句。"]


def test_interrupt_multi_sentence_partial():
    """多句回合、用户看到一句半：整句保留、未看到的删掉、半句补一行。"""
    _add_multi_turn("在吗", ["第一句。", "第二句。"])
    checkpoint.interrupt_turn("在吗", "第一句。第二")
    assert _live_texts() == ["在吗", "第一句。", "第二"]


def test_interrupt_multi_sentence_none_seen():
    """多句回合、一句都没看到：本回合 assistant 行全删，user 行只留一条。"""
    _add_multi_turn("在吗", ["第一句。", "第二句。", "第三句。"])
    checkpoint.interrupt_turn("在吗", "")
    assert _live_texts() == []


def test_interrupt_multi_sentence_idempotent():
    """多句回合重复打断：收敛到同一状态（不重复插 user 行）。"""
    _add_multi_turn("在吗", ["第一句。", "第二句。"])
    checkpoint.interrupt_turn("在吗", "第一句。")
    checkpoint.interrupt_turn("在吗", "第一句。")
    assert _live_texts() == ["在吗", "第一句。"]


def test_interrupt_idempotent_no_double_user():
    """重复打断同一回合不产生重复 user 行。"""
    add_turn("在吗", "完整回复")
    checkpoint.interrupt_turn("在吗", "完整")
    checkpoint.interrupt_turn("在吗", "完整")
    assert _live_texts() == ["在吗", "完整"]


def test_interrupt_endpoint():
    client = TestClient(app)
    add_turn("在吗", "完整回复哦")
    r = client.post("/api/chat/interrupt", json={"user": "在吗", "assistant": "完整"})
    assert r.status_code == 204
    assert _live_texts() == ["在吗", "完整"]


def test_compress_rolls_old_summary(monkeypatch):
    """已有摘要时把旧摘要连同新折叠段一起滚入新摘要。"""
    _seed(4)
    _set_summary("旧摘要")
    got = []

    def fake(llm_cfg, messages, tools=None, usage_out=None, **kwargs):
        got.append(messages[-1]["content"])
        return {"role": "assistant", "content": "新摘要"}

    monkeypatch.setattr(llm, "chat_completion", fake)
    assert compress.compress_once() is True
    assert "旧摘要" in got[-1]  # 旧摘要被喂给 LLM 滚入
    assert _live_summary() == "新摘要"
    assert len(checkpoint.live_messages()) == 8


def test_compress_below_threshold_noop(monkeypatch):
    _seed(4)
    monkeypatch.setattr(compress, "Thread", _InlineThread)
    monkeypatch.setattr(llm, "chat_stream", _fake_chat("好。", prompt_tokens=1))
    list(turn.run_turn("hi"))
    assert _live_summary() == ""
    assert (
        len(checkpoint.live_messages()) == 8
    )  # newly generated reply awaits display ACK


def test_compress_single_flight():
    compress._lock.acquire()  # 模拟已有任务在跑
    try:
        assert compress.maybe_compress(10**9) is False
    finally:
        compress._lock.release()


def test_compress_failure_silent(monkeypatch):
    """压缩失败静默：不写 summary、锁释放可重试、不影响对话。"""
    _seed(4)
    monkeypatch.setattr(compress, "Thread", _InlineThread)

    def boom(llm_cfg, messages, tools=None, usage_out=None, **kwargs):
        raise llm.LlmError("down")

    monkeypatch.setattr(llm, "chat_completion", boom)
    assert compress.maybe_compress(10**9) is True
    assert _live_summary() == ""
    assert compress._lock.acquire(blocking=False)
    compress._lock.release()


def test_compress_aborts_when_generation_moved(monkeypatch):
    """压缩进行期间会话被 load/打断（代际变更）→ 放弃写回，不破坏新会话。"""
    _seed(4)

    def fake(llm_cfg, messages, tools=None, usage_out=None, **kwargs):
        checkpoint.interrupt_turn("", "")  # 代际 +1（等价 load 效果）
        return {"role": "assistant", "content": "摘要"}

    monkeypatch.setattr(llm, "chat_completion", fake)
    assert compress.compress_once() is False
    assert _live_summary() == ""
    assert len(checkpoint.live_messages()) == 8


def test_live_cap_under_limit_no_trim():
    """不足 100 条不裁剪；恰好 100 条也不动。"""
    _seed(49)
    assert len(checkpoint.live_messages()) == 98
    add_turn("问49", "答49")
    msgs = checkpoint.live_messages()
    assert len(msgs) == 100
    assert msgs[0]["text"] == "问0"  # 一条未删
