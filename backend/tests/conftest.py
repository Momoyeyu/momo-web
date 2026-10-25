"""测试公共 fixture：把数据文件重定向到 tmp_path，隔离真实 backend/data。"""

from __future__ import annotations

import pytest

from app.core import db, state
from app.services import checkpoint, memory
from app.core import embed


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch, request):
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "STATE_PATH", tmp_path / "momo.yaml")
    memory.shutdown_index()
    db.reset()
    monkeypatch.setattr(memory, "schedule_index", lambda: None)
    if request.node.get_closest_marker("bundled_model") is None:
        monkeypatch.setattr(embed, "embed", lambda *a, **k: None)
    yield
    memory.shutdown_index()
    db.reset()


def add_turn(user: str, assistant: str, at: str = "2025-01-01T00:00:00+00:00"):
    """测试助手：向 live 会话落一对 user/assistant（模拟已完成的回合）。"""
    gen = checkpoint.generation()
    checkpoint.begin_turn(user, gen, at)
    checkpoint.append_sentence(assistant, gen, at)
    checkpoint.acknowledge(checkpoint.current_run(gen, at), assistant, gen)
    checkpoint.finish_turn(gen, at)
