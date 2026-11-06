"""Opt-in real bundled resources, always using the isolated test database.

MOMO_TEST_BUNDLED_MODEL=1 uv run pytest tests/test_embedding_model.py -q
"""
import json
import os
from pathlib import Path
import socket

import pytest

from app.core import embed
from app.services import memory

pytestmark = [pytest.mark.bundled_model, pytest.mark.skipif(
    os.environ.get('MOMO_TEST_BUNDLED_MODEL') != '1', reason='opt-in real bundled model')]


def test_offline_multilingual_recall_uses_bundled_model(monkeypatch):
    def no_network(*args, **kwargs):
        raise AssertionError('Bundled embedding must not open a network connection')
    monkeypatch.setattr(socket, 'create_connection', no_network)
    monkeypatch.setattr(memory, 'schedule_index', lambda: None)
    fixture = json.loads((Path(__file__).parent / 'fixtures/embedding_recall.json').read_text())
    ids = [memory.add_memory(content)['id'] for content in fixture['memories']]
    memory.rebuild_index()
    assert memory.index_status()['indexed'] == 20
    for case in fixture['queries']:
        hits = memory.search_memories(case['query'])
        assert ids[case['expected']] in [hit['id'] for hit in hits], case
    assert embed.status()['state'] == 'loaded'


def test_corrupt_bundled_model_degrades_without_network(tmp_path, monkeypatch):
    root = tmp_path / 'corrupt-model'
    root.mkdir()
    (root / 'model_quantized.onnx').write_bytes(b'broken')
    (root / 'manifest.json').write_text(json.dumps({'model_identity':embed.MODEL_ID,'files':[
        {'path':'model_quantized.onnx','size_bytes':6,'sha256':'wrong'}]}))
    monkeypatch.setattr(embed, 'resource_dir', lambda: root)
    assert embed.embed('test') is None
    assert 'checksum failed' in embed.status()['error']
