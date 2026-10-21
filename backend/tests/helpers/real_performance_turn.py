"""One real LLM turn through FastAPI, with temporary history/config and no socket.

Called by the opt-in browser test. Provider credentials stay local; stdout carries
only the HTTP result. User memory, checkpoints, configuration and services are untouched.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

backend = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(backend))
import yaml

request = json.load(sys.stdin)
original = yaml.safe_load((backend / 'data/momo.yaml').read_text())
with tempfile.TemporaryDirectory(prefix='momo-performance-') as directory:
    os.environ['MOMO_DATA_DIR'] = directory
    from app.core import state, db
    from app.main import app
    from fastapi.testclient import TestClient
    settings = state.normalize_state(original)
    settings['settings']['extensions'] = []
    settings['settings']['general']['lang'] = 'zh'
    settings['settings']['general']['chatLang'] = 'zh'
    state.write_state(settings)
    try:
        response = TestClient(app).post('/api/chat', json=request)
        print(json.dumps({'status': response.status_code, 'body': response.text}, ensure_ascii=False))
    finally:
        db.reset()
