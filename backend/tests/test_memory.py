"""记忆：校验/去重（归一化全等 + bigram Jaccard）/ 搜索（embedding mock）/ 增删改。"""
from __future__ import annotations

import pytest

from app import embed, memory


def _no_embed(text: str, cfg=None):
    return None


def test_add_validate_and_list():
    mem = memory.add_memory("  用户喜欢草莓蛋糕  ")
    assert mem["content"] == "用户喜欢草莓蛋糕"  # strip
    assert len(mem["id"]) == 12
    assert memory.list_memories()[0]["id"] == mem["id"]

    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("   ")
    assert e.value.kind == "invalid"

    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("x" * 501)
    assert e.value.kind == "invalid"


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
    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("用户叫夜羽", pins=["用户叫夜羽"])
    assert e.value.kind == "duplicate"
    # 设计要求判重返回冲突 id + content：pin 冲突给 pin:* 伪 id
    assert "pin:" in str(e.value)


def test_dedup_returns_conflict_id():
    """判重报错带回冲突记忆 id+content，模型可直接 memory_update 修正。"""
    mem = memory.add_memory("用户喜欢草莓蛋糕")
    with pytest.raises(memory.MemoryError) as e:
        memory.add_memory("用户喜欢草莓蛋糕")
    assert mem["id"] in str(e.value)
    assert "用户喜欢草莓蛋糕" in str(e.value)


def test_edit_and_delete():
    mem = memory.add_memory("旧内容")
    edited = memory.edit_memory(mem["id"], "新内容")
    assert edited["id"] == mem["id"]
    assert edited["content"] == "新内容"

    with pytest.raises(memory.MemoryError) as e:
        memory.edit_memory("nonexistent", "x")
    assert e.value.kind == "not_found"

    with pytest.raises(memory.MemoryError) as e:
        memory.delete_memory("pin:abc123")
    assert e.value.kind == "invalid"  # pin 不可删

    with pytest.raises(memory.MemoryError) as e:
        memory.edit_memory("pin:abc123", "改写")
    assert e.value.kind == "not_found"  # pin:* 不在普通记忆 → not_found

    memory.delete_memory(mem["id"])
    assert memory.list_memories() == []

    with pytest.raises(memory.MemoryError) as e:
        memory.delete_memory(mem["id"])
    assert e.value.kind == "not_found"


def test_edit_excludes_self_in_dedup():
    mem = memory.add_memory("用户喜欢草莓蛋糕和巧克力")
    # 编辑成与自身近似的内容不应被判重
    edited = memory.edit_memory(mem["id"], "用户喜欢草莓蛋糕和巧克力！")
    assert edited["content"].endswith("！")


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


def test_search_embedding_path_and_lazy_cache(monkeypatch):
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

    res = memory.search_memories("query", pins=["用户叫夜羽"])
    assert len(res) <= 5
    # pin cosine 最高 → 第一
    assert res[0]["id"].startswith("pin:")
    assert res[0]["content"] == "用户叫夜羽"
    ids = [r["id"] for r in res]
    assert m2["id"] in ids  # 香蕉 cosine 次高

    # 懒算落盘：cache 文件已写，含各内容 hash
    cache = memory._load_cache()
    assert memory._hash("香蕉") in cache
    assert memory._hash("用户叫夜羽") in cache

    # 二次搜索命中缓存，不再重复算内容向量
    calls.clear()
    memory.search_memories("query", pins=["用户叫夜羽"])
    assert calls == ["query"]


def test_import_legacy():
    n = memory.import_legacy(
        [
            {"content": "a"},
            {"content": "a"},  # 重复
            {"content": "b", "valid": False},
            "not a dict",
            {"content": 42},
        ]
    )
    assert n == 1
    assert [m["content"] for m in memory.list_memories()] == ["a"]
