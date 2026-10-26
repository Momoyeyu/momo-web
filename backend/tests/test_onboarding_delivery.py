"""Onboarding progress follows observed replies and survives profile recovery."""

import json

import pytest

from app.core import db, llm, state
from app.services import archive, checkpoint, memory, onboarding, turn


@pytest.fixture
def first_meeting(monkeypatch):
    cfg = state.load()
    cfg['settings']['llm'] = {'url': 'https://example.test', 'model': 'test', 'key': ''}
    state.write_state(cfg)
    events = onboarding.opening(None)
    checkpoint.acknowledge(events[0]['runId'], ''.join(e['text'] for e in events), events[0]['generation'])

    def classify(action, name='', quote=''):
        monkeypatch.setattr(llm, 'chat_completion', lambda *a, **k: {
            'tool_calls': [{'function': {'name': 'first_meeting_result', 'arguments': json.dumps({
                'action': action, 'name': name, 'quote': quote,
            })}}],
        })

    return classify


def reply(monkeypatch, text='你好，小羽。'):
    monkeypatch.setattr(llm, 'chat_stream', lambda *a, **k: iter([{'type': 'text', 'delta': text}]))


def ack(events, text=None):
    sentences = [e for e in events if e['t'] == 'sentence']
    return checkpoint.acknowledge(sentences[0]['runId'], text or ''.join(e['text'] for e in sentences), sentences[0]['generation'])


def test_failed_name_reply_keeps_first_meeting_retryable(first_meeting, monkeypatch):
    first_meeting('name', '小羽', '叫我小羽')

    def fail(*a, **k):
        raise llm.LlmError('reply failed')
        yield

    monkeypatch.setattr(llm, 'chat_stream', fail)
    assert list(turn.run_turn('叫我小羽', first_meeting=True))[0]['t'] == 'error'
    assert onboarding.status()['stage'] == 'asking'
    assert memory.list_memories() == []
    assert not db.query('SELECT * FROM memories')
    reply(monkeypatch)
    events = list(turn.run_turn('叫我小羽', first_meeting=True))
    assert ack(events)
    assert onboarding.status()['stage'] == 'completed'
    assert len(memory.list_memories()) == 1


def test_late_display_ack_finishes_name_once(first_meeting, monkeypatch):
    first_meeting('name', '小羽', '叫我小羽')
    reply(monkeypatch)
    events = list(turn.run_turn('叫我小羽', first_meeting=True))
    assert onboarding.status()['stage'] == 'asking'
    assert memory.list_memories() == []
    assert ack(events)
    assert ack(events)
    assert onboarding.status()['stage'] == 'completed'
    assert len(memory.list_memories()) == 1


def test_retry_replaces_unobserved_name_without_duplicates(first_meeting, monkeypatch):
    first_meeting('name', '小羽', '叫我小羽')
    reply(monkeypatch)
    list(turn.run_turn('叫我小羽', first_meeting=True))
    events = list(turn.run_turn('叫我小羽', first_meeting=True))
    assert ack(events)
    assert onboarding.status()['stage'] == 'completed'
    assert len(memory.list_memories()) == 1
    assert len(db.query('SELECT * FROM memories')) == 1


def test_unobserved_clarification_does_not_consume_allowance(first_meeting, monkeypatch):
    first_meeting('clarify')
    reply(monkeypatch, '希望我怎么称呼你呢？')
    list(turn.run_turn('你猜', first_meeting=True))
    assert onboarding.status()['stage'] == 'asking'
    events = list(turn.run_turn('再猜猜', first_meeting=True))
    assert onboarding.status()['stage'] == 'asking'
    assert ack(events)
    assert onboarding.status()['stage'] == 'clarifying'
    skipped = list(turn.run_turn('还是猜猜', first_meeting=True))
    assert onboarding.status()['stage'] == 'clarifying'
    assert ack(skipped)
    assert onboarding.status()['stage'] == 'skipped'


@pytest.mark.parametrize('seen', ['', '你好'])
def test_interrupt_commits_only_observed_name(first_meeting, monkeypatch, seen):
    first_meeting('name', '小羽', '叫我小羽')
    reply(monkeypatch)
    events = list(turn.run_turn('叫我小羽', first_meeting=True))
    sentence = next(e for e in events if e['t'] == 'sentence')
    onboarding.interrupt('叫我小羽', seen, sentence['generation'], run_id=sentence['runId'])
    assert onboarding.status()['stage'] == ('completed' if seen else 'asking')
    assert len(memory.list_memories()) == (1 if seen else 0)
    assert len(db.query('SELECT * FROM memories')) == (1 if seen else 0)


@pytest.mark.parametrize('action', ['name', 'clarify'])
def test_empty_interrupt_reverts_previously_acknowledged_outcome(first_meeting, monkeypatch, action):
    first_meeting(action, '小羽' if action == 'name' else '', '叫我小羽' if action == 'name' else '')
    reply(monkeypatch)
    text = '叫我小羽' if action == 'name' else '你猜'
    events = list(turn.run_turn(text, first_meeting=True))
    assert ack(events)
    assert onboarding.status()['stage'] == ('completed' if action == 'name' else 'clarifying')
    sentence = next(e for e in events if e['t'] == 'sentence')
    onboarding.interrupt(text, '', sentence['generation'], run_id=sentence['runId'])
    assert onboarding.status()['stage'] == 'asking'
    assert memory.list_memories() == []
    assert not db.query('SELECT * FROM memories')


def test_empty_name_interrupt_removes_derived_vector(first_meeting, monkeypatch):
    from app.models import vectors

    if db.sqlite_vec is None:
        pytest.skip('sqlite-vec unavailable')
    first_meeting('name', '小羽', '叫我小羽')
    reply(monkeypatch)
    events = list(turn.run_turn('叫我小羽', first_meeting=True))
    assert ack(events)
    mid = memory.list_memories()[0]['id']
    assert vectors.ensure(2, 'onboarding-test')
    with db.tx() as c:
        vectors.put(c, mid, [1.0, 0.0])
    sentence = next(e for e in events if e['t'] == 'sentence')
    onboarding.interrupt('叫我小羽', '', sentence['generation'], run_id=sentence['runId'])
    assert not db.query('SELECT id FROM memory_vec WHERE id=?', (mid,))


def test_restore_partial_opening_preserves_asking_and_remaining_text():
    cfg = state.load()
    cfg['settings']['llm'] = {'url': 'https://example.test', 'model': 'test', 'key': ''}
    state.write_state(cfg)
    events = onboarding.opening(None)
    full = ''.join(e['text'] for e in events)
    seen = full[:3]
    checkpoint.acknowledge(events[0]['runId'], seen, events[0]['generation'])
    archive.import_data(archive.export_data())
    assert onboarding.status()['stage'] == 'asking'
    assert onboarding.status()['pendingOpening']
    resumed = onboarding.opening(None)
    assert seen + ''.join(e['text'] for e in resumed) == full
    assert ack(resumed)
    assert ''.join(m['text'] for m in checkpoint.live_messages()) == full


def test_restore_retires_unobserved_name_but_preserves_retry(first_meeting, monkeypatch):
    first_meeting('name', '小羽', '叫我小羽')
    reply(monkeypatch)
    events = list(turn.run_turn('叫我小羽', first_meeting=True))
    archive.import_data(archive.export_data())
    assert onboarding.status()['stage'] == 'asking'
    assert memory.list_memories() == []
    assert not db.query('SELECT * FROM memories')
    assert not ack(events)
    retried = list(turn.run_turn('叫我小羽', first_meeting=True))
    assert ack(retried)
    assert onboarding.status()['stage'] == 'completed'


def test_restore_preserves_observed_clarifying_stage(first_meeting, monkeypatch):
    first_meeting('clarify')
    reply(monkeypatch, '希望我怎么称呼你呢？')
    assert ack(list(turn.run_turn('你猜', first_meeting=True)))
    assert onboarding.status()['stage'] == 'clarifying'
    archive.import_data(archive.export_data())
    assert onboarding.status()['stage'] == 'clarifying'


def test_failed_restore_preserves_previous_onboarding_progress(first_meeting, monkeypatch):
    saved = archive.export_data()
    first_meeting('clarify')
    reply(monkeypatch, '希望我怎么称呼你呢？')
    assert ack(list(turn.run_turn('你猜', first_meeting=True)))
    gen = checkpoint.generation()

    def fail():
        raise RuntimeError('injected reconciliation failure')

    monkeypatch.setattr(archive, '_reconcile_restored_extensions', fail)
    with pytest.raises(RuntimeError, match='injected reconciliation'):
        archive.import_data(saved)
    assert checkpoint.generation() > gen
    assert onboarding.status()['stage'] == 'clarifying'
