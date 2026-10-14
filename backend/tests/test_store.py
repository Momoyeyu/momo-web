"""state 读写 + 默认值归一化 + 旧 memories 导入。"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import memory, store
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
    assert s["history"] == []


def test_normalize_tolerates_junk():
    s = store.normalize_state({"persona": None, "pins": "oops"})
    assert s["persona"]["name"] == "momo"
    assert s["pins"] == "oops"  # 非 None 值原样透传（容错，不强行纠正类型）


def test_append_history_cap():
    store.append_history(
        [{"role": "user", "text": str(i), "at": "t"} for i in range(120)]
    )
    h = store.get_state()["history"]
    assert len(h) == 100
    assert h[-1]["text"] == "119"


def test_put_state_legacy_import_and_strip():
    client = TestClient(app)
    body = {
        "pins": ["用户叫夜羽"],
        "user": {"name": "夜羽"},  # 旧 schema，应被忽略且不写回
        "memories": [
            {"content": "用户喜欢草莓蛋糕"},
            {"content": "用户喜欢草莓蛋糕"},  # 重复 → 只入一条
            {"content": "已失效记忆", "valid": False},  # valid==False 跳过
            {"kind": "episodic"},  # 无 content 跳过
        ],
        "avatars": [],
    }
    r = client.put("/api/state", json=body)
    assert r.status_code == 204

    mems = memory.list_memories()
    assert [m["content"] for m in mems] == ["用户喜欢草莓蛋糕"]
    assert len(mems[0]["id"]) == 12
    assert mems[0]["createdAt"]

    stored = store.read_state()
    assert "memories" not in stored
    assert "user" not in stored

    r = client.get("/api/state")
    assert r.status_code == 200
    assert r.json()["pins"] == ["用户叫夜羽"]


def test_get_state_endpoint_empty():
    client = TestClient(app)
    r = client.get("/api/state")
    assert r.status_code == 200
    assert r.json() == {}
