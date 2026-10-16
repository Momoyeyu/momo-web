"""state 读写 + 默认值归一化（持久化文件 = data/momo.yaml）。"""
from __future__ import annotations

import yaml
from fastapi.testclient import TestClient

from app.core import state as store
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
    # 人设不属于配置（写死在 prompt.PERSONA）
    assert "persona" not in s
    # 未知字段透传
    assert s["custom"] == {"x": 1}


def test_normalize_tolerates_junk():
    s = store.normalize_state({"custom": "oops"})
    assert s["custom"] == "oops"  # 非 None 值原样透传（容错，不强行纠正类型）


def test_persona_lives_in_soul_file_not_config():
    """人设不在配置里，而在 resources/soul.md：用户改不到，开发者直接编辑文件。"""
    assert "persona" not in store.normalize_state({})
    from app.services import prompt

    soul = prompt.load_soul()
    assert soul, "soul 文件应存在且非空"
    assert prompt.SOUL_PATH.name == "soul.md"


def test_put_state_roundtrip():
    """PUT 整体写入、GET 归一化回吐。"""
    client = TestClient(app)
    r = client.put(
        "/api/state",
        json={
            "settings": {"general": {"lang": "en"}},
            "legacy": {"name": "momo"},
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
        json={"legacy": {"name": "桃"}, "custom": {"x": 1}},
    )
    assert r.status_code == 204
    raw = store.STATE_PATH.read_text(encoding="utf-8")
    assert "name: 桃" in raw  # YAML 明文
    assert yaml.safe_load(raw) == {"legacy": {"name": "桃"}, "custom": {"x": 1}}
    # 读回走同一文件
    assert store.get_state()["legacy"]["name"] == "桃"


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


def test_fresh_install_ships_no_initial_preferences_or_memories():
    """回归保护：新装不带任何初始记忆，全部由用户自己添加。

    历史上出厂状态种过示例偏好与初始记忆（前端 DEFAULT_PINS，随 momo.db 迁移进了 DB），
    偏好功能已整体删除、初始记忆也已清空 —— 这条用例钉住它，谁再种回来就会红。
    """
    from app.services import memory

    assert "persona" not in store.load()  # 人设不在配置里（唯一来源是 resources/soul.md）
    assert memory.list_memories() == []


def test_default_state_has_no_stale_pins_key():
    """旧格式的 pins 键（初始记忆）已废弃：State 模型里没有它，也不该再回去。"""
    st = store.load()
    assert "pins" not in st
