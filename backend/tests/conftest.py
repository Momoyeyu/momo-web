"""测试公共 fixture：把数据文件重定向到 tmp_path，隔离真实 backend/data。"""
from __future__ import annotations

import pytest

from app import checkpoint, db, store


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    monkeypatch.setattr(store, "STATE_PATH", tmp_path / "momo.yaml")
    db.reset()
    yield
    db.reset()


def add_turn(user: str, assistant: str, at: str = "2025-01-01T00:00:00+00:00"):
    """测试助手：向 live 会话落一对 user/assistant（模拟已完成的回合）。"""
    gen = checkpoint.generation()
    checkpoint.begin_turn(user, gen, at)
    checkpoint.commit_reply(assistant, gen, at)
