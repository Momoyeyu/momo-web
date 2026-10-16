"""会话存档 REST + 上下文压缩 + 打断/代际竞态：CRUD / auto 槽 / load 往返 / 压缩。"""
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


def _fake_chat(content="好。", prompt_tokens=0):
    def fake(llm_cfg, messages, tools=None, usage_out=None):
        if usage_out is not None:
            usage_out.update({"prompt_tokens": prompt_tokens})
        return {"role": "assistant", "content": content}

    return fake


# ---------- REST ----------

def test_save_list_get():
    client = TestClient(app)
    _seed(2, "甲")
    r = client.post("/api/checkpoints", json={"title": "档一"})
    assert r.status_code == 201
    sid = r.json()["id"]
    assert len(sid) == 8
    assert r.json()["slot"] == 1

    lst = client.get("/api/checkpoints").json()
    assert len(lst) == 1
    item = lst[0]
    assert item["title"] == "档一" and item["auto"] is False
    assert item["slot"] == 1
    assert item["createdAt"] and item["updatedAt"]
    assert item["preview"] == "甲答1"  # 末条消息截断
    assert "messages" not in item

    full = client.get(f"/api/checkpoints/{sid}").json()
    assert [m["role"] for m in full["messages"]] == ["user", "assistant"] * 2
    assert full["messages"][0]["text"] == "甲问0"


def test_save_default_title_and_empty_body():
    client = TestClient(app)
    r = client.post("/api/checkpoints")  # 无 body → title 默认当前时间
    assert r.status_code == 201
    item = client.get("/api/checkpoints").json()[0]
    assert item["title"]


def test_overwrite_and_rename():
    client = TestClient(app)
    _seed(1, "旧")
    sid = client.post("/api/checkpoints", json={"title": "a"}).json()["id"]
    _seed(1, "新")  # 当前会话追加一回合

    r = client.put(f"/api/checkpoints/{sid}", json={"title": "改名"})
    assert r.status_code == 200
    assert r.json()["title"] == "改名"
    assert "messages" not in r.json()

    full = client.get(f"/api/checkpoints/{sid}").json()
    assert len(full["messages"]) == 4  # 已被当前会话整体覆盖
    assert full["messages"][-1]["text"] == "新答0"

    # 不传 title：只覆盖内容，标题保留
    r = client.put(f"/api/checkpoints/{sid}", json={})
    assert r.status_code == 200
    assert client.get(f"/api/checkpoints/{sid}").json()["title"] == "改名"


def test_delete_and_404():
    client = TestClient(app)
    sid = client.post("/api/checkpoints", json={}).json()["id"]
    assert client.delete(f"/api/checkpoints/{sid}").status_code == 204
    assert client.get("/api/checkpoints").json() == []
    assert client.delete(f"/api/checkpoints/{sid}").status_code == 404
    assert client.get(f"/api/checkpoints/{sid}").status_code == 404
    assert client.post(f"/api/checkpoints/{sid}/load").status_code == 404


def test_live_transcript_endpoint():
    client = TestClient(app)
    _seed(1, "甲")
    r = client.get("/api/checkpoints/live")
    assert r.status_code == 200
    body = r.json()
    assert [m["text"] for m in body["messages"]] == ["甲问0", "甲答0"]
    # live 不出现在存档列表里
    assert client.get("/api/checkpoints").json() == []


def test_load_roundtrip_and_auto_slot():
    client = TestClient(app)
    _seed(2, "甲")
    sid_a = client.post("/api/checkpoints", json={"title": "A"}).json()["id"]
    _seed(1, "乙")  # 当前 = A + 一回合
    sid_b = client.post("/api/checkpoints", json={"title": "B"}).json()["id"]

    r = client.post(f"/api/checkpoints/{sid_a}/load")
    assert r.status_code == 200
    assert _live_texts() == ["甲问0", "甲答0", "甲问1", "甲答1"]  # 回到 A 时点

    # load 前现场进 auto 槽
    autos = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos) == 1
    auto_full = client.get(f"/api/checkpoints/{autos[0]['id']}").json()
    assert [m["text"] for m in auto_full["messages"]] == [
        "甲问0", "甲答0", "甲问1", "甲答1", "乙问0", "乙答0",
    ]

    # 再 load B：auto 槽原地覆盖，不新增
    assert client.post(f"/api/checkpoints/{sid_b}/load").status_code == 200
    autos2 = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos2) == 1 and autos2[0]["id"] == autos[0]["id"]
    assert _live_texts() == ["甲问0", "甲答0", "甲问1", "甲答1", "乙问0", "乙答0"]

    # load auto 槽自己 → 还原被 B 顶掉的现场
    auto_id = autos[0]["id"]
    assert client.post(f"/api/checkpoints/{auto_id}/load").status_code == 200
    autos3 = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos3) == 1 and autos3[0]["id"] == auto_id


def test_load_with_summary_roundtrip():
    client = TestClient(app)
    _seed(1)
    _set_summary("旧摘要")
    sid = client.post("/api/checkpoints", json={}).json()["id"]
    _set_summary("")
    client.post(f"/api/checkpoints/{sid}/load")
    assert _live_summary() == "旧摘要"


def test_load_empty_current_skips_auto():
    client = TestClient(app)
    _seed(1)
    sid = client.post("/api/checkpoints", json={}).json()["id"]
    # 清空当前会话 → load 不写 auto 槽
    with db.tx() as c:
        c.execute("DELETE FROM messages WHERE session_id=?", (db.LIVE_ID,))
    client.post(f"/api/checkpoints/{sid}/load")
    assert all(not s["auto"] for s in client.get("/api/checkpoints").json())


def test_live_id_not_addressable():
    client = TestClient(app)
    assert client.get("/api/checkpoints/live").status_code == 200
    # live 不能被当存档读/删/覆盖/载入
    assert client.delete("/api/checkpoints/live").status_code == 404
    assert client.put("/api/checkpoints/live", json={}).status_code == 404
    assert client.post("/api/checkpoints/live/load").status_code == 404


# ---------- 槽位号 ----------

def test_slot_sequential_and_delete_recycles():
    """未指定 slot → 最小编号空槽；删除后槽位释放可复用。"""
    client = TestClient(app)
    a = client.post("/api/checkpoints", json={}).json()
    b = client.post("/api/checkpoints", json={}).json()
    assert (a["slot"], b["slot"]) == (1, 2)
    assert client.delete(f"/api/checkpoints/{a['id']}").status_code == 204
    c = client.post("/api/checkpoints", json={}).json()
    assert c["slot"] == 1  # 最小空槽被回收复用


def test_slot_explicit_and_gap_fill():
    """指定空槽则用之；未指定跳过已占槽取最小空号；列表按 slot 排序。"""
    client = TestClient(app)
    r = client.post("/api/checkpoints", json={"slot": 5})
    assert r.status_code == 201 and r.json()["slot"] == 5
    assert client.post("/api/checkpoints", json={}).json()["slot"] == 1
    lst = client.get("/api/checkpoints").json()
    assert [s["slot"] for s in lst] == [1, 5]


def test_slot_out_of_range_and_occupied():
    client = TestClient(app)
    assert client.post("/api/checkpoints", json={"slot": 0}).status_code == 400
    assert client.post("/api/checkpoints", json={"slot": 121}).status_code == 400
    sid = client.post("/api/checkpoints", json={"slot": 3}).json()["id"]
    assert sid
    r = client.post("/api/checkpoints", json={"slot": 3})
    assert r.status_code == 409


def test_auto_slot_not_deletable():
    client = TestClient(app)
    _seed(1)
    sid = client.post("/api/checkpoints", json={}).json()["id"]
    _seed(1, "乙")
    client.post(f"/api/checkpoints/{sid}/load")
    autos = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos) == 1
    assert client.delete(f"/api/checkpoints/{autos[0]['id']}").status_code == 400


def test_auto_slot_not_overwritable():
    """PUT 覆盖 auto 槽与删除同规则：400 invalid，内容不被改动。"""
    client = TestClient(app)
    _seed(1, "甲")
    sid = client.post("/api/checkpoints", json={}).json()["id"]
    _seed(1, "乙")
    client.post(f"/api/checkpoints/{sid}/load")  # 现场进 auto 槽
    autos = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos) == 1
    auto_id = autos[0]["id"]
    before = client.get(f"/api/checkpoints/{auto_id}").json()["messages"]

    assert client.put(f"/api/checkpoints/{auto_id}", json={}).status_code == 400
    r = client.put(f"/api/checkpoints/{auto_id}", json={"title": "改名"})
    assert r.status_code == 400
    after = client.get(f"/api/checkpoints/{auto_id}").json()
    assert after["messages"] == before  # 未被覆盖
    assert after["title"] == autos[0]["title"]  # 标题未被改


def test_overwrite_auto_direct_raises_invalid():
    """存储层直连：覆盖 auto 槽抛 CheckpointError(kind='invalid')，同 delete。"""
    _seed(1)
    sid = checkpoint.create_checkpoint()["id"]
    _seed(1, "乙")
    checkpoint.load_checkpoint(sid)  # 现场进 auto 槽
    auto_id = db.query(
        "SELECT id FROM sessions WHERE auto=1 AND id != ?", (db.LIVE_ID,)
    )[0]["id"]
    with pytest.raises(checkpoint.CheckpointError) as ei:
        checkpoint.overwrite_checkpoint(auto_id)
    assert ei.value.kind == "invalid"


def test_preview_uses_last_message():
    client = TestClient(app)
    _seed(3, "丙")
    client.post("/api/checkpoints", json={})
    item = client.get("/api/checkpoints").json()[0]
    assert item["preview"] == "丙答2"


def test_auto_slot_has_no_slot_number():
    client = TestClient(app)
    _seed(1, "甲")
    sid = client.post("/api/checkpoints", json={}).json()["id"]
    _seed(1, "乙")
    client.post(f"/api/checkpoints/{sid}/load")  # 当前现场进 auto 槽
    autos = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos) == 1 and autos[0]["slot"] is None


# ---------- 打断 / 代际 ----------

def test_interrupt_truncates_committed_reply():
    """回复已落账后打断：assistant 行截到用户看到的部分。"""
    add_turn("在吗", "很长很长的完整回复")
    checkpoint.interrupt_turn("在吗", "很长")
    assert _live_texts() == ["在吗", "很长"]


def test_interrupt_empty_display_deletes_reply():
    """打断时一个字都没看到：assistant 行删除，保留 user。"""
    add_turn("在吗", "完整回复")
    checkpoint.interrupt_turn("在吗", "")
    assert _live_texts() == ["在吗"]


def test_interrupt_kills_pending_commit():
    """打断先于回复落账：代际 +1 使在途 commit_reply 作废。"""
    gen = checkpoint.generation()
    assert checkpoint.begin_turn("在吗", gen, "t")
    checkpoint.interrupt_turn("在吗", "")
    assert checkpoint.commit_reply("完整回复", gen, "t") is False
    assert _live_texts() == ["在吗"]  # 回复没落库


def test_interrupt_pending_with_seen_text():
    """打断在生成中且用户已看到部分文本：user 已落账 → 补写看到的部分。"""
    gen = checkpoint.generation()
    assert checkpoint.begin_turn("在吗", gen, "t")
    checkpoint.interrupt_turn("在吗", "看到了一半")
    assert checkpoint.commit_reply("完整回复", gen, "t") is False
    assert _live_texts() == ["在吗", "看到了一半"]


def test_interrupt_turn_never_reached_backend():
    """SSE 没到 backend 就被打断：尾对不匹配 → 按所见补写整对。"""
    _seed(1, "旧")
    checkpoint.interrupt_turn("新问", "看到一点")
    assert _live_texts() == ["旧问0", "旧答0", "新问", "看到一点"]


def test_interrupt_idempotent_no_double_user():
    """重复打断同一回合不产生重复 user 行。"""
    add_turn("在吗", "完整回复")
    checkpoint.interrupt_turn("在吗", "看到")
    checkpoint.interrupt_turn("在吗", "看到")
    assert _live_texts() == ["在吗", "看到"]


def test_load_invalidates_inflight_turn(monkeypatch):
    """回合进行中 load：commit 代际校验失败 → 不写入新会话、不推流。"""
    _seed(1, "甲")
    client = TestClient(app)
    sid = client.post("/api/checkpoints", json={}).json()["id"]
    _seed(1, "乙")
    gen = checkpoint.generation()
    assert checkpoint.begin_turn("途中的问题", gen, "t9")
    client.post(f"/api/checkpoints/{sid}/load")  # 代际 +1
    assert checkpoint.commit_reply("迟到回复", gen, "t9") is False
    assert _live_texts() == ["甲问0", "甲答0"]  # 迟到回复没落进新会话
    # auto 槽里留有被顶掉的现场（含途中 user 消息）
    autos = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    auto = client.get(f"/api/checkpoints/{autos[0]['id']}").json()
    assert auto["messages"][-1]["text"] == "途中的问题"


def test_run_turn_skips_stream_when_gen_stale(monkeypatch):
    """load 后的在途 run_turn：commit 失败 → 不 yield delta。"""
    _seed(1, "甲")
    client = TestClient(app)
    sid = client.post("/api/checkpoints", json={}).json()["id"]

    def fake(llm_cfg, messages, tools=None, usage_out=None):
        client.post(f"/api/checkpoints/{sid}/load")  # LLM 返回前发生读档
        return {"role": "assistant", "content": "迟到回复"}

    monkeypatch.setattr(llm, "chat_completion", fake)
    events = list(turn.run_turn("hi"))
    assert [e for e in events if e["t"] == "delta"] == []


def test_interrupt_endpoint():
    client = TestClient(app)
    add_turn("在吗", "完整回复哦")
    r = client.post(
        "/api/chat/interrupt", json={"user": "在吗", "assistant": "完整"}
    )
    assert r.status_code == 204
    assert _live_texts() == ["在吗", "完整"]


# ---------- 上下文压缩 ----------

def test_compress_trigger_and_assembly(monkeypatch):
    """用量达阈值：回合末后台压缩最旧一半 → summary 落盘 + messages 截断；
    下一回合上下文 = system + 摘要 + 最近窗口。"""
    _seed(4)  # 8 条
    monkeypatch.setattr(compress, "Thread", _InlineThread)
    monkeypatch.setattr(
        llm, "chat_completion", _fake_chat("摘要一", prompt_tokens=10**9)
    )

    events = list(turn.run_turn("继续"))
    assert any(e["t"] == "delta" for e in events)

    assert _live_summary() == "摘要一"
    # 落盘后 10 条 → 折 4 条（完整回合取整）→ 剩 6
    assert len(checkpoint.live_messages()) == 6
    assert _live_texts()[0] == "问2"

    # 下一回合：摘要作为独立 system 消息注入，最近窗口照旧
    seen = []

    def spy(llm_cfg, messages, tools=None, usage_out=None):
        seen.append(list(messages))
        return {"role": "assistant", "content": "嗯。"}

    monkeypatch.setattr(llm, "chat_completion", spy)
    list(turn.run_turn("再来"))
    sys_msgs = [m for m in seen[0] if m["role"] == "system"]
    assert len(sys_msgs) == 2
    assert "摘要一" in sys_msgs[1]["content"]
    assert seen[0][-1] == {"role": "user", "content": "再来"}


def test_compress_rolls_old_summary(monkeypatch):
    """已有摘要时把旧摘要连同新折叠段一起滚入新摘要。"""
    _seed(4)
    _set_summary("旧摘要")
    got = []

    def fake(llm_cfg, messages, tools=None, usage_out=None):
        got.append(messages[-1]["content"])
        return {"role": "assistant", "content": "新摘要"}

    monkeypatch.setattr(llm, "chat_completion", fake)
    assert compress.compress_once() is True
    assert "旧摘要" in got[-1]  # 旧摘要被喂给 LLM 滚入
    assert _live_summary() == "新摘要"
    assert len(checkpoint.live_messages()) == 4


def test_compress_below_threshold_noop(monkeypatch):
    _seed(4)
    monkeypatch.setattr(compress, "Thread", _InlineThread)
    monkeypatch.setattr(llm, "chat_completion", _fake_chat("好。", prompt_tokens=1))
    list(turn.run_turn("hi"))
    assert _live_summary() == ""
    assert len(checkpoint.live_messages()) == 10


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

    def boom(llm_cfg, messages, tools=None, usage_out=None):
        raise llm.LlmError("down")

    monkeypatch.setattr(llm, "chat_completion", boom)
    assert compress.maybe_compress(10**9) is True
    assert _live_summary() == ""
    assert compress._lock.acquire(blocking=False)
    compress._lock.release()


def test_compress_aborts_when_generation_moved(monkeypatch):
    """压缩进行期间会话被 load/打断（代际变更）→ 放弃写回，不破坏新会话。"""
    _seed(4)

    def fake(llm_cfg, messages, tools=None, usage_out=None):
        checkpoint.interrupt_turn("", "")  # 代际 +1（等价 load 效果）
        return {"role": "assistant", "content": "摘要"}

    monkeypatch.setattr(llm, "chat_completion", fake)
    assert compress.compress_once() is False
    assert _live_summary() == ""
    assert len(checkpoint.live_messages()) == 8


# ---------- live.messages 上限（cap 100） ----------

def test_live_cap_under_limit_no_trim():
    """不足 100 条不裁剪；恰好 100 条也不动。"""
    _seed(49)
    assert len(checkpoint.live_messages()) == 98
    add_turn("问49", "答49")
    msgs = checkpoint.live_messages()
    assert len(msgs) == 100
    assert msgs[0]["text"] == "问0"  # 一条未删


def test_live_cap_trims_oldest_turns():
    """超界后保留最新 100 条，最旧的完整回合被裁掉。"""
    _seed(51)  # 102 条 → 末次 commit 触发裁剪
    msgs = checkpoint.live_messages()
    assert len(msgs) == 100
    assert msgs[0]["role"] == "user"
    assert _live_texts()[:2] == ["问1", "答1"]  # 问0/答0 整对删除


def test_live_cap_boundary_never_splits_turn():
    """裁剪点落在 assistant 上 → 多留一条，剩余最早一条仍是 user。"""
    _seed(50)  # 100 条
    gen = checkpoint.generation()
    # 两条连续 user 把总数顶成奇数（实际场景可由打断/删除造成），
    # 使 103 - 100 = 3 的裁剪点落在「答1」（assistant）上
    checkpoint.begin_turn("落单的问1", gen, "t")
    checkpoint.begin_turn("落单的问2", gen, "t")
    assert checkpoint.commit_reply("答", gen, "t") is True
    msgs = checkpoint.live_messages()
    assert len(msgs) == 101  # 多留一条
    assert msgs[0]["role"] == "user"  # 回合不被从中间切开
    assert _live_texts()[:2] == ["问1", "答1"]  # 问0/答0 整对删除


def test_live_cap_trim_happens_in_commit_tx():
    """裁剪与落账同一事务：commit 成功后立即满足上限，外部读不到超界状态。"""
    _seed(50)
    add_turn("问50", "答50")  # 102 → commit 内部即裁剪
    # 用独立 query 再查一次，落账与裁剪已原子生效
    n = db.query(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id=?", (db.LIVE_ID,)
    )[0]["n"]
    assert n == 100


# ---------- 新会话（标题页「开始」） ----------


def test_new_session_snapshots_and_clears_live():
    """POST live/new：live 非空先进 auto 槽，然后清空；summary 一并清。"""
    client = TestClient(app)
    _seed(2)
    _set_summary("旧会话摘要")
    gen_before = checkpoint.generation()

    r = client.post("/api/checkpoints/live/new")
    assert r.status_code == 204
    assert checkpoint.live_messages() == []
    assert _live_summary() == ""
    assert checkpoint.generation() == gen_before + 1  # 在途写入作废

    autos = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos) == 1
    full = client.get(f"/api/checkpoints/{autos[0]['id']}").json()
    assert [m["text"] for m in full["messages"]] == ["问0", "答0", "问1", "答1"]
    assert full["summary"] == "旧会话摘要"


def test_new_session_empty_live_no_auto_slot():
    """live 本来就空：不产生 auto 槽，live 仍为空。"""
    client = TestClient(app)
    r = client.post("/api/checkpoints/live/new")
    assert r.status_code == 204
    assert checkpoint.live_messages() == []
    assert client.get("/api/checkpoints").json() == []


def test_new_session_again_overwrites_auto_slot():
    """连续两次新会话：第二次的现场原地覆盖 auto 槽，不新增。"""
    client = TestClient(app)
    _seed(1, "甲")
    client.post("/api/checkpoints/live/new")
    autos1 = [s for s in client.get("/api/checkpoints").json() if s["auto"]]

    _seed(1, "乙")
    client.post("/api/checkpoints/live/new")
    autos2 = [s for s in client.get("/api/checkpoints").json() if s["auto"]]
    assert len(autos2) == 1 and autos2[0]["id"] == autos1[0]["id"]
    full = client.get(f"/api/checkpoints/{autos2[0]['id']}").json()
    assert [m["text"] for m in full["messages"]] == ["乙问0", "乙答0"]
