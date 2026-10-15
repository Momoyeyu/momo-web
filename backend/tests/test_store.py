"""state 读写 + 默认值归一化（持久化文件 = data/momo.yaml）。"""
from __future__ import annotations

import yaml
from fastapi.testclient import TestClient

from app import store
from app.main import app


def test_get_state_empty_returns_empty_dict():
    assert store.read_state() is None
    assert store.get_state() == {}


def test_write_then_read_normalized():
    store.write_state({"settings": {"general": {"lang": "en"}}, "custom": {"x": 1}})
    s = store.get_state()
    # 已有字段保留
    assert s["settings"]["general"]["lang"] == "en"
    # 缺失字段补默认值
    assert s["settings"]["general"]["dialogOpacity"] == 66
    assert s["settings"]["llm"] == {"url": "", "key": "", "model": ""}
    assert s["persona"]["name"] == "momo"
    # 未知字段透传
    assert s["custom"] == {"x": 1}


def test_normalize_tolerates_junk():
    s = store.normalize_state({"persona": None, "custom": "oops"})
    assert s["persona"]["name"] == "momo"
    assert s["custom"] == "oops"  # 非 None 值原样透传（容错，不强行纠正类型）


def test_put_state_roundtrip():
    """PUT 整体写入、GET 归一化回吐。"""
    client = TestClient(app)
    r = client.put(
        "/api/state",
        json={
            "settings": {"general": {"lang": "en"}},
            "persona": {"name": "momo"},
        },
    )
    assert r.status_code == 204
    r = client.get("/api/state")
    assert r.status_code == 200
    s = r.json()
    assert s["settings"]["general"]["lang"] == "en"
    assert s["settings"]["general"]["dialogOpacity"] == 66
    assert s["avatars"][0]["id"] == "builtin"


def test_get_state_endpoint_empty():
    client = TestClient(app)
    r = client.get("/api/state")
    assert r.status_code == 200
    assert r.json() == {}


def test_state_persisted_as_momo_yaml():
    """PUT 落盘为 data/momo.yaml（YAML 明文）；HTTP 层载荷仍是 JSON。"""
    assert store.STATE_PATH.name == "momo.yaml"
    client = TestClient(app)
    r = client.put(
        "/api/state",
        json={"persona": {"name": "桃"}, "custom": {"x": 1}},
    )
    assert r.status_code == 204
    raw = store.STATE_PATH.read_text(encoding="utf-8")
    assert "name: 桃" in raw  # YAML 明文
    assert yaml.safe_load(raw) == {"persona": {"name": "桃"}, "custom": {"x": 1}}
    # 读回走同一文件
    assert store.get_state()["persona"]["name"] == "桃"


def test_read_state_tolerates_corrupt_yaml():
    store.STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    store.STATE_PATH.write_text("a: [1, 2", encoding="utf-8")  # 非法 YAML
    assert store.read_state() is None
    assert store.get_state() == {}


def test_read_state_non_mapping_returns_none():
    """YAML 合法但顶层不是 mapping（如裸列表/字符串）→ 视为无数据。"""
    store.STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    store.STATE_PATH.write_text("- just\n- a\n- list\n", encoding="utf-8")
    assert store.read_state() is None
    assert store.get_state() == {}
