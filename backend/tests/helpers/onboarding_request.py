"""Isolated first-meeting HTTP bridge for browser tests; never writes real data."""
import copy
import json
import os
import sys
import tempfile
from pathlib import Path
import yaml
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))
request = json.loads(sys.stdin.readline())
directory = Path(request['directory'])
if not directory.name.startswith('momo-first-meeting-') or directory.resolve().parent != Path(tempfile.gettempdir()).resolve():
    raise ValueError('Expected an isolated test directory')
os.environ['MOMO_DATA_DIR'] = str(directory)
for key in ('MOMO_DESKTOP_TOKEN','MOMO_DESKTOP_NONCE','MOMO_WEB_ORIGIN'):
    os.environ.pop(key,None)
from app.core import state, db, llm
from app.services import checkpoint
from app.main import app
from fastapi.testclient import TestClient
if not state.STATE_PATH.exists():
    original = copy.deepcopy(state.DEFAULT_STATE)
    if request.get('real'):
        fixture = os.environ.get('MOMO_BROWSER_LLM_CONFIG')
        if not fixture:
            raise ValueError('Real provider tests require explicit MOMO_BROWSER_LLM_CONFIG')
        original = state.normalize_state(yaml.safe_load(Path(fixture).read_text(encoding='utf-8')))
    original['settings']['extensions'] = []
    original['settings']['general'].update(lang=request.get('lang', 'zh'), chatLang='auto', textSpeed=100, sentenceSpeed=100, voiceInput=False)
    original['settings']['tts'] = {'url': '', 'key': '', 'voice': '', 'prompt': ''}
    if request.get('tts'):
        original['settings']['tts'] = {'url': 'https://voice.test', 'key': '', 'voice': 'test.wav', 'prompt': ''}
    original['avatars'] = [state.DEFAULT_STATE['avatars'][0]]
    original['avatarId'] = 'builtin'
    if not request.get('real'):
        original['settings']['llm'] = {'url': 'https://preview.test', 'model': 'test', 'key': ''} if request.get('configured', True) else {'url': '', 'model': '', 'key': ''}
    if not request.get("pristine"):
        state.write_state(state.normalize_state(original))
    if request.get('legacy'):
        at=db.now_iso();gen=checkpoint.generation()
        checkpoint.begin_turn('旧对话',gen,at)
        checkpoint.append_sentence('欢迎回来。',gen,at)
        checkpoint.acknowledge(checkpoint.current_run(gen,at),'欢迎回来。',gen)
if not request.get('real'):
    def classify(*a, **k):
        text = a[1][-1]['content']
        if text == '模拟失败': raise llm.LlmError('simulated failure')
        action = 'name' if text.startswith('叫我') else 'clarify' if text == '你猜' else 'skip'
        return {'tool_calls': [{'function': {'name': 'first_meeting_result', 'arguments': json.dumps({'action': action, 'name': text[2:] if action == 'name' else '', 'quote': text if action == 'name' else ''})}}]}
    def stream(*a, **k):
        messages = a[1]
        saved = next((r['content'] for r in db.query('SELECT content FROM memories')), '')
        text = ('小星，我记住啦。你现在想聊什么？' if saved else '没关系，我们先聊聊吧。')
        yield {'type': 'text', 'delta': text}
    llm.chat_completion = classify
    llm.chat_stream = stream
def dispatch(request):
    response = TestClient(app).request(request.get('method', 'GET'), request['path'], json=request.get('body'))
    print(json.dumps({'status': response.status_code, 'body': response.text, 'contentType': response.headers.get('content-type', 'application/json'), 'headers': {'x-momo-generation':response.headers['x-momo-generation']} if 'x-momo-generation' in response.headers else {}}, ensure_ascii=False), flush=True)

from app.services.coordinator import runtime
from app.services.extend import configure
runtime.start()
configure([])
try:
    dispatch(request)
    if os.environ.get('MOMO_ONBOARDING_BRIDGE') == '1':
        for line in sys.stdin:
            dispatch(json.loads(line))
finally:
    runtime.close()
    db.reset()
