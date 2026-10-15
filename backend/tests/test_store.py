"""state 读写 + 默认值归一化。"""
from __future__ import annotations

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
