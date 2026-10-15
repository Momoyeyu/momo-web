"""会话存档 REST + 上下文压缩：CRUD / auto 槽 / load 往返 / 压缩触发与组装。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app import agent, llm, store
from app.agent import compress
from app.main import app


def _seed(turns: int, prefix: str = "") -> list[dict]:
    """往当前会话追加 turns 个完整回合，返回追加的条目列表。"""
    entries = []
    for i in range(turns):
        entries.append({"role": "user", "text": f"{prefix}问{i}", "at": f"{prefix}t{i}a"})
        entries.append(
            {"role": "assistant", "text": f"{prefix}答{i}", "at": f"{prefix}t{i}b"}
        )
    store.append_history(entries)
    return entries


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
    r = client.post("/api/sessions", json={"title": "档一"})
    assert r.status_code == 201
    sid = r.json()["id"]
    assert len(sid) == 8
    assert r.json()["slot"] == 1

    lst = client.get("/api/sessions").json()
    assert len(lst) == 1
    item = lst[0]
    assert item["title"] == "档一" and item["auto"] is False
    assert item["slot"] == 1
    assert item["createdAt"] and item["updatedAt"]
    assert item["preview"] == "甲答1"  # 末条消息截断
    assert "messages" not in item

    full = client.get(f"/api/sessions/{sid}").json()
    assert [m["role"] for m in full["messages"]] == ["user", "assistant"] * 2
    assert full["messages"][0]["text"] == "甲问0"


def test_save_default_title_and_empty_body():
    client = TestClient(app)
    r = client.post("/api/sessions")  # 无 body → title 默认当前时间
    assert r.status_code == 201
    item = client.get("/api/sessions").json()[0]
    assert item["title"]


def test_overwrite_and_rename():
    client = TestClient(app)
    _seed(1, "旧")
    sid = client.post("/api/sessions", json={"title": "a"}).json()["id"]
    _seed(1, "新")  # 当前会话追加一回合

    r = client.put(f"/api/sessions/{sid}", json={"title": "改名"})
    assert r.status_code == 200
    assert r.json()["title"] == "改名"
    assert "messages" not in r.json()

    full = client.get(f"/api/sessions/{sid}").json()
    assert len(full["messages"]) == 4  # 已被当前会话整体覆盖
    assert full["messages"][-1]["text"] == "新答0"

    # 不传 title：只覆盖内容，标题保留
    r = client.put(f"/api/sessions/{sid}", json={})
    assert r.status_code == 200
    assert client.get(f"/api/sessions/{sid}").json()["title"] == "改名"


def test_delete_and_404():
    client = TestClient(app)
    sid = client.post("/api/sessions", json={}).json()["id"]
    assert client.delete(f"/api/sessions/{sid}").status_code == 204
    assert client.get("/api/sessions").json() == []
    assert client.delete(f"/api/sessions/{sid}").status_code == 404
    assert client.get(f"/api/sessions/{sid}").status_code == 404
    assert client.post(f"/api/sessions/{sid}/load").status_code == 404


def test_load_roundtrip_and_auto_slot():
    client = TestClient(app)
    entries_a = _seed(2, "甲")
    sid_a = client.post("/api/sessions", json={"title": "A"}).json()["id"]
    entries_b = _seed(1, "乙")  # 当前 = A + 一回合
    sid_b = client.post("/api/sessions", json={"title": "B"}).json()["id"]

    r = client.post(f"/api/sessions/{sid_a}/load")
    assert r.status_code == 200
    assert store.get_state()["history"] == entries_a  # 回到 A 时点

    # load 前现场进 auto 槽
    autos = [s for s in client.get("/api/sessions").json() if s["auto"]]
    assert len(autos) == 1
    auto_full = client.get(f"/api/sessions/{autos[0]['id']}").json()
    assert auto_full["messages"] == entries_a + entries_b

    # 再 load B：auto 槽原地覆盖，不新增
    assert client.post(f"/api/sessions/{sid_b}/load").status_code == 200
    autos2 = [s for s in client.get("/api/sessions").json() if s["auto"]]
    assert len(autos2) == 1 and autos2[0]["id"] == autos[0]["id"]
    assert store.get_state()["history"] == entries_a + entries_b

    # load auto 槽自己 → 还原被 B 顶掉的现场（load 前 = A，又进 auto 槽）
    auto_id = autos[0]["id"]
    assert client.post(f"/api/sessions/{auto_id}/load").status_code == 200
    autos3 = [s for s in client.get("/api/sessions").json() if s["auto"]]
    assert len(autos3) == 1 and autos3[0]["id"] == auto_id


def test_load_with_summary_roundtrip():
    client = TestClient(app)
    _seed(1)
    store.update_state(lambda st: st.__setitem__("summary", "旧摘要"))
    sid = client.post("/api/sessions", json={}).json()["id"]
    store.write_state({"history": [], "summary": ""})
    client.post(f"/api/sessions/{sid}/load")
    assert store.get_state()["summary"] == "旧摘要"


def test_load_empty_current_skips_auto():
    client = TestClient(app)
    _seed(1)
    sid = client.post("/api/sessions", json={}).json()["id"]
    store.write_state({"history": []})
    client.post(f"/api/sessions/{sid}/load")
    assert all(not s["auto"] for s in client.get("/api/sessions").json())


# ---------- 槽位号 ----------

def test_slot_sequential_and_delete_recycles():
    """未指定 slot → 最小编号空槽；删除后槽位释放可复用。"""
    client = TestClient(app)
    a = client.post("/api/sessions", json={}).json()
    b = client.post("/api/sessions", json={}).json()
    assert (a["slot"], b["slot"]) == (1, 2)
    assert client.delete(f"/api/sessions/{a['id']}").status_code == 204
    c = client.post("/api/sessions", json={}).json()
    assert c["slot"] == 1  # 最小空槽被回收复用


def test_slot_explicit_and_gap_fill():
    """指定空槽则用之；未指定跳过已占槽取最小空号；列表按 slot 排序。"""
    client = TestClient(app)
    r = client.post("/api/sessions", json={"slot": 5})
    assert r.status_code == 201 and r.json()["slot"] == 5
    assert client.post("/api/sessions", json={}).json()["slot"] == 1
    lst = client.get("/api/sessions").json()
    assert [s["slot"] for s in lst] == [1, 5]


def test_slot_out_of_range_and_occupied():
    client = TestClient(app)
    assert client.post("/api/sessions", json={"slot": 0}).status_code == 400
    assert client.post("/api/sessions", json={"slot": 121}).status_code == 400
    sid = client.post("/api/sessions", json={"slot": 3}).json()["id"]
    assert sid
    r = client.post("/api/sessions", json={"slot": 3})
    assert r.status_code == 409


def test_slot_migration_legacy_entries():
    """旧 sessions.json 无 slot 字段：读取时按文件序补号，auto 槽不占号。"""
    import json as _json

    from app import session

    legacy = [
        {
            "id": "legacy01",
            "title": "旧档A",
            "auto": False,
            "createdAt": "t",
            "updatedAt": "t",
            "summary": "",
            "messages": [{"role": "user", "text": "一", "at": "t"}],
        },
        {
            "id": "legacyauto",
            "title": "旧auto",
            "auto": True,
            "createdAt": "t",
            "updatedAt": "t",
            "summary": "",
            "messages": [],
        },
        {
            "id": "legacy02",
            "title": "旧档B",
            "auto": False,
            "createdAt": "t",
            "updatedAt": "t",
            "summary": "",
            "messages": [{"role": "assistant", "text": "二", "at": "t"}],
        },
    ]
    session.SESSIONS_PATH.write_text(
        _json.dumps(legacy, ensure_ascii=False), encoding="utf-8"
    )
    lst = TestClient(app).get("/api/sessions").json()
    by_id = {s["id"]: s for s in lst}
    assert by_id["legacy01"]["slot"] == 1
    assert by_id["legacy02"]["slot"] == 2
    assert by_id["legacyauto"]["slot"] is None
    assert lst[0]["id"] == "legacyauto"  # auto 置顶
    # 迁移后新建接最小编号空槽
    assert TestClient(app).post("/api/sessions", json={}).json()["slot"] == 3


def test_preview_uses_last_message():
    client = TestClient(app)
    _seed(3, "丙")
    client.post("/api/sessions", json={})
    item = client.get("/api/sessions").json()[0]
    assert item["preview"] == "丙答2"


def test_auto_slot_has_no_slot_number():
    client = TestClient(app)
    _seed(1, "甲")
    sid = client.post("/api/sessions", json={}).json()["id"]
    _seed(1, "乙")
    client.post(f"/api/sessions/{sid}/load")  # 当前现场进 auto 槽
    autos = [s for s in client.get("/api/sessions").json() if s["auto"]]
    assert len(autos) == 1 and autos[0]["slot"] is None


# ---------- 上下文压缩 ----------

def test_compress_trigger_and_assembly(monkeypatch):
    """用量达阈值：回合末后台压缩最旧一半 → summary 落盘 + history 截断；
    下一回合上下文 = system + 摘要 + 最近窗口。"""
    _seed(4)  # 8 条
    monkeypatch.setattr(compress, "Thread", _InlineThread)
    monkeypatch.setattr(
        llm, "chat_completion", _fake_chat("摘要一", prompt_tokens=10**9)
    )

    events = list(agent.run_turn("继续"))
    assert any(e["t"] == "delta" for e in events)

    state = store.get_state()
    assert state["summary"] == "摘要一"
    # 落盘后 10 条 → 折 4 条（完整回合取整）→ 剩 6
    assert len(state["history"]) == 6
    assert state["history"][0]["text"] == "问2"

    # 下一回合：摘要作为独立 system 消息注入，最近窗口照旧
    seen = []

    def spy(llm_cfg, messages, tools=None, usage_out=None):
        seen.append(list(messages))
        return {"role": "assistant", "content": "嗯。"}

    monkeypatch.setattr(llm, "chat_completion", spy)
    list(agent.run_turn("再来"))
    sys_msgs = [m for m in seen[0] if m["role"] == "system"]
    assert len(sys_msgs) == 2
    assert "摘要一" in sys_msgs[1]["content"]
    assert seen[0][-1] == {"role": "user", "content": "再来"}


def test_compress_rolls_old_summary(monkeypatch):
    """已有摘要时把旧摘要连同新折叠段一起滚入新摘要。"""
    _seed(4)
    store.update_state(lambda st: st.__setitem__("summary", "旧摘要"))
    got = []

    def fake(llm_cfg, messages, tools=None, usage_out=None):
        got.append(messages[-1]["content"])
        return {"role": "assistant", "content": "新摘要"}

    monkeypatch.setattr(llm, "chat_completion", fake)
    assert compress.compress_once() is True
    assert "旧摘要" in got[-1]  # 旧摘要被喂给 LLM 滚入
    assert store.get_state()["summary"] == "新摘要"
    assert len(store.get_state()["history"]) == 4


def test_compress_below_threshold_noop(monkeypatch):
    _seed(4)
    monkeypatch.setattr(compress, "Thread", _InlineThread)
    monkeypatch.setattr(llm, "chat_completion", _fake_chat("好。", prompt_tokens=1))
    list(agent.run_turn("hi"))
    assert store.get_state()["summary"] == ""
    assert len(store.get_state()["history"]) == 10


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
    assert store.get_state()["summary"] == ""
    assert compress._lock.acquire(blocking=False)
    compress._lock.release()


def test_compress_aborts_when_history_moved(monkeypatch):
    """压缩进行期间 history 被整体换掉（如 load）→ 放弃写回，不破坏新会话。"""
    _seed(4)

    def fake(llm_cfg, messages, tools=None, usage_out=None):
        store.write_state(
            {"history": [{"role": "user", "text": "x", "at": "t"}]}
        )
        return {"role": "assistant", "content": "摘要"}

    monkeypatch.setattr(llm, "chat_completion", fake)
    assert compress.compress_once() is False
    state = store.get_state()
    assert state["summary"] == ""
    assert state["history"][0]["text"] == "x"
