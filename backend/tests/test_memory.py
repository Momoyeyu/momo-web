"""记忆：校验/去重（归一化全等 + bigram Jaccard）/ 搜索（embedding mock）/ 增删改。"""
from __future__ import annotations

import pytest

from app.core import embed
from app.core import db
from app.services import memory


def _no_embed(text: str, cfg=None):
    return None


def test_add_validate_and_list():
    mem = memory.add_memory("  用户喜欢草莓蛋糕  ")
    assert mem["content"] == "用户喜欢草莓蛋糕"  # strip
    assert mem["pinned"] is False
    assert len(mem["id"]) == 12
    assert memory.list_memories()[0]["id"] == mem["id"]

    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("   ")
    assert e.value.kind == "invalid"

    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("x" * 501)
    assert e.value.kind == "invalid"


def test_pinned_rows():
    """初始记忆 = pinned=1 的记忆行：pins() 只列文本，列表带标记。"""
    pin = memory.add_memory("用户的名称是夜羽", pinned=True)
    memory.add_memory("用户是程序员")
    assert memory.pins() == ["用户的名称是夜羽"]
    assert memory.is_pinned(pin["id"])
    assert not memory.is_pinned("不存在")
    by_flag = memory.list_memories(pinned=True)
    assert [m["id"] for m in by_flag] == [pin["id"]]


def test_dedup_normalized_equal():
    memory.add_memory("用户喜欢草莓蛋糕")
    with pytest.raises(memory.MemoryError) as e:
        # 归一化（去标点/空白/大小写）后全等 → 重复
        memory.add_memory(" 用户喜欢草莓蛋糕！")
    assert e.value.kind == "duplicate"
    assert "重复" in str(e.value)


def test_dedup_jaccard():
    base = "momo喜欢吃草莓蛋糕和巧克力"
    memory.add_memory(base)
    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory(base + "哦")  # bigram Jaccard = 12/13 > 0.85
    assert e.value.kind == "duplicate"

    # 相似度低 → 不判重
    mem = memory.add_memory("用户今天在调试冒烟测试")
    assert mem["id"]


def test_dedup_against_pins():
    """pin 与普通记忆同表：撞 pin 也判重，返回的是真实行 id。"""
    pin = memory.add_memory("用户叫夜羽", pinned=True)
    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("用户叫夜羽")
    assert e.value.kind == "duplicate"
    assert pin["id"] in str(e.value)


def test_dedup_returns_conflict_id():
    """判重报错带回冲突记忆 id+content，模型可直接 memory_update 修正。"""
    mem = memory.add_memory("用户喜欢草莓蛋糕")
    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("用户喜欢草莓蛋糕")
    assert mem["id"] in str(e.value)
    assert "用户喜欢草莓蛋糕" in str(e.value)


def test_edit_and_delete():
    mem = memory.add_memory("旧内容")
    edited = memory.update_memory(mem["id"], "新内容")
    assert edited["id"] == mem["id"]
    assert edited["content"] == "新内容"

    with pytest.raises(memory.MemoryError) as e:
        memory.update_memory("nonexistent", "x")
    assert e.value.kind == "not_found"

    memory.delete_memory(mem["id"])
    assert memory.list_memories() == []

    with pytest.raises(memory.MemoryError) as e:
        memory.delete_memory(mem["id"])
    assert e.value.kind == "not_found"


def test_pin_crud_via_rest_not_tool():
    """pin 行：REST/存储层可改删（设置页维护），能力层拦截。"""
    from app.services.capability import execute_tool

    pin = memory.add_memory("用户叫夜羽", pinned=True)
    # 工具路径：pin 不可删/改
    msg = execute_tool("memory_delete", {"id": pin["id"]})
    assert "不可删除" in msg or "pin" in msg
    msg = execute_tool("memory_update", {"id": pin["id"], "content": "x"})
    assert "pin" in msg
    assert memory.pins() == ["用户叫夜羽"]  # 未被改动
    # 存储层（REST 走这层）可以直接维护
    memory.update_memory(pin["id"], "夜羽大人")
    memory.delete_memory(pin["id"])
    assert memory.pins() == []


def test_edit_excludes_self_in_dedup():
    mem = memory.add_memory("用户喜欢草莓蛋糕和巧克力")
    # 编辑成与自身近似的内容不应被判重
    edited = memory.update_memory(mem["id"], "用户喜欢草莓蛋糕和巧克力！")
    assert edited["content"].endswith("！")


def test_semantic_search_switch(monkeypatch):
    """设置页「语义检索」关掉 → _embed_cfg 返回 {}，与未配置等价。"""
    from app.core import state as cfg

    state = cfg.normalize_state(None)
    state["settings"]["general"]["semanticSearch"] = False
    cfg.write_state(state)
    assert memory.embedding_config() == {}

    state["settings"]["general"]["semanticSearch"] = True
    cfg.write_state(state)
    assert memory.embedding_config().get("url")


def test_search_jaccard_fallback(monkeypatch):
    monkeypatch.setattr(embed, "embed", _no_embed)
    memory.add_memory("用户喜欢草莓蛋糕")
    memory.add_memory("用户讨厌苦味")
    memory.add_memory("今天天气很好")
    res = memory.search_memories("用户喜欢什么蛋糕")
    assert res[0]["content"] == "用户喜欢草莓蛋糕"
    assert all(set(r) == {"id", "content"} for r in res)
    # 与 query 零 bigram 重叠的条目不返回
    assert "今天天气很好" not in [r["content"] for r in res]


def test_search_embedding_path_and_lazy_fill(monkeypatch):
    vecs = {
        "query": [1.0, 0.0],
        "苹果": [0.0, 1.0],
        "香蕉": [0.9, 0.1],
        "西瓜": [0.1, 0.9],
        "用户叫夜羽": [0.95, 0.05],
    }
    calls = []

    def fake_embed(text, cfg=None):
        calls.append(text)
        return vecs.get(text)

    monkeypatch.setattr(embed, "embed", fake_embed)
    m1 = memory.add_memory("苹果")
    m2 = memory.add_memory("香蕉")
    memory.add_memory("西瓜")
    pin = memory.add_memory("用户叫夜羽", pinned=True)

    res = memory.search_memories("query")
    assert len(res) <= 5
    # pin cosine 最高 → 第一（pin 也是真实行 id）
    assert res[0]["id"] == pin["id"]
    assert res[0]["content"] == "用户叫夜羽"
    ids = [r["id"] for r in res]
    assert m2["id"] in ids  # 香蕉 cosine 次高

    # 懒算补写：memory_vec 已有候选项的向量
    vec_ids = {r["id"] for r in db.query("SELECT id FROM memory_vec")}
    assert {m1["id"], m2["id"], pin["id"]} <= vec_ids

    # 二次搜索命中缓存，不再重复算内容向量
    calls.clear()
    memory.search_memories("query")
    assert calls == ["query"]
