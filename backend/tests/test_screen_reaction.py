"""Observed screen events share dialogue persistence without a forged user message."""
import time
from unittest.mock import patch

from app.core import db, llm
from app.services import checkpoint, turn
from app.services.computer import Computer


def test_reaction_uses_shared_sentence_ack_and_no_player_message(monkeypatch):
    seen = []
    def provider(_cfg, messages, tools=None, **kwargs):
        seen.append((messages, tools))
        yield {'type': 'text', 'delta': 'The window has changed.'}
    monkeypatch.setattr(llm, 'chat_stream', provider)
    events = list(turn.run_turn('', run_id='screen-reaction', observation={'source':'Shared screen','observedAt':'now'}))
    assert not [event for event in events if event['t'] == 'error']
    sentence = next(event for event in events if event['t'] == 'sentence')
    assert 'userEventId' not in sentence
    assert seen[0][1] == []
    assert seen[0][0][-1]['role'] == 'system'
    assert 'not a player request' in seen[0][0][-1]['content']
    rows = db.query('SELECT role,visible FROM messages WHERE run_id=?', ('screen-reaction',))
    assert [r['role'] for r in rows] == ['assistant']
    assert rows[0]['visible'] == 0
    checkpoint.acknowledge('screen-reaction', sentence['text'], sentence['generation'])
    assert db.query('SELECT visible FROM messages WHERE run_id=?', ('screen-reaction',))[0]['visible'] == 1
    assert dict(db.query('SELECT * FROM run_observations')[0]) == {'run_id':'screen-reaction','source':'Shared screen','observed_at':'now'}


def test_silent_reaction_finishes_without_fabricating_history(monkeypatch):
    calls = []
    def provider(*args, **kwargs):
        calls.append(1)
        yield {'type':'text','delta':''}
    monkeypatch.setattr(llm, 'chat_stream', provider)
    assert list(turn.run_turn('', observation={'source':'screen','observedAt':'now'})) == []
    assert len(calls) == 1
    assert db.query('SELECT * FROM messages') == []


def test_observation_does_not_execute_unrequested_tools(monkeypatch):
    def provider(*args, **kwargs):
        yield {'type':'tool_calls','calls':[{'id':'bad','function':{'name':'browser_action','arguments':'{}'}}]}
    monkeypatch.setattr(llm, 'chat_stream', provider)
    monkeypatch.setattr(turn, 'run_call', lambda *args: (_ for _ in ()).throw(AssertionError('must not execute')))
    events = list(turn.run_turn('', observation={'source':'screen','observedAt':'now'}))
    assert events[-1]['t'] == 'error'


def test_claim_enforces_fresh_generation_and_rate_without_inference():
    computer = Computer()
    computer.observing = computer.proactive = computer.reactions = True
    computer.frame = b'private'
    computer.last = time.monotonic()
    computer.signature = (150,) * 256
    computer.unknown = False
    with patch.object(computer, 'gate'), patch('app.services.computer.runtime') as runtime:
        runtime.active = runtime.presentation = None
        runtime.queue = []
        runtime.interrupt_hold = False
        assert computer.claim_reaction(9,'client','lease') is None
        assert computer.claim_reaction(0,'client','lease') == {'generation':0}
        assert computer.claim_reaction(0,'client','lease') is None
        runtime.enqueue.assert_not_called()


def test_suppressed_endpoint_does_not_enqueue_or_run(monkeypatch):
    from app.api.chat import screen_reaction, ScreenReactionIn
    from app.services.computer import computer
    from app.services.coordinator import runtime
    monkeypatch.setattr(computer, 'claim_reaction', lambda *args: None)
    monkeypatch.setattr(runtime, 'enqueue', lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('suppressed event must not enqueue')))
    response = screen_reaction(ScreenReactionIn(generation=1, clientId='client', leaseId='lease'))
    import asyncio
    async def read():
        return ''.join([part async for part in response.body_iterator])
    assert '"suppressed": true' in asyncio.run(read())
    assert db.query('SELECT * FROM runs') == []


def test_endpoint_admission_stages_pixels_without_player_interrupt(monkeypatch):
    import asyncio
    import base64
    import io
    from contextlib import contextmanager
    from PIL import Image
    from app.api.chat import screen_reaction, ScreenReactionIn
    from app.services.computer import computer
    from app.services import computer_tools, vision
    from app.services.coordinator import runtime
    image = io.BytesIO()
    Image.new('RGB', (32,32), 'red').save(image, 'PNG')
    for key, value in {'frame':image.getvalue(), 'last':time.monotonic(), 'observing':True,
                       'proactive':True, 'reactions':True, 'generation':7, 'analyses':0,
                       'source':'screen', 'observed':'now'}.items():
        monkeypatch.setattr(computer, key, value, raising=False)
    monkeypatch.setattr(computer, 'gate', lambda: {})
    monkeypatch.setattr(computer, 'claim_reaction', lambda *args: {'generation':7})
    monkeypatch.setattr(runtime, 'require_meeting', lambda *args: None)
    monkeypatch.setattr(runtime, 'enqueue', lambda *args: {'acceptedNew':True,'id':'inbox','run_id':'observed-run'})
    monkeypatch.setattr(runtime, 'prepare_local', lambda *args: (_ for _ in ()).throw(AssertionError('observation is not player interruption')))
    @contextmanager
    def run(*args, **kwargs):
        yield None
    monkeypatch.setattr(runtime, 'run', run)
    monkeypatch.setattr(runtime, 'inbox_status', lambda *args: None)
    monkeypatch.setattr(runtime, 'present', lambda *args: 'presentation-token')
    monkeypatch.setattr(computer_tools, 'require_local', lambda: 'observed-run')
    monkeypatch.setattr(vision, 'require_enabled', lambda *args: None)
    seen = []
    def provider(cfg, messages, **kwargs):
        url = messages[-1]['content'][1]['image_url']['url']
        assert Image.open(io.BytesIO(base64.b64decode(url.split(',')[1]))).size == (32,32)
        seen.append(True)
        yield {'type':'text','delta':'A red screen.'}
    monkeypatch.setattr(llm, 'chat_stream', provider)
    response = screen_reaction(ScreenReactionIn(generation=7, clientId='client', leaseId='lease'))
    async def read():
        return ''.join([part async for part in response.body_iterator])
    body = asyncio.run(read())
    assert seen == [True]
    assert 'presentation-token' in body
    assert '"t": "error"' not in body
    assert 'base64' not in str([dict(r) for r in db.query('SELECT * FROM messages')])
    assert [r['role'] for r in db.query('SELECT * FROM messages')] == ['assistant']
