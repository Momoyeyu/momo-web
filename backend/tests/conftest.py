"""测试公共 fixture：把所有数据文件重定向到 tmp_path，隔离真实 backend/data。"""
from __future__ import annotations

import pytest

from app import memory, store


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "STATE_PATH", tmp_path / "state.json")
    monkeypatch.setattr(memory, "MEMORIES_PATH", tmp_path / "memories.json")
    monkeypatch.setattr(
        memory, "EMBEDDINGS_PATH", tmp_path / "memory-embeddings.json"
    )
    yield
