"""Deterministic compaction boundary checks, no real user data or network."""
import threading
import pytest
from conftest import add_turn
from app.core import llm
from app.services import compress, checkpoint


def seed():
    for i in range(10): add_turn(f'Shared event {i}: we agreed to visit a garden.', 'I remember the garden plan.', at=str(i))


@pytest.mark.parametrize('response',[{'content':''}, {'content':'x'*6001}, {'content':'Invented'*800}, {'content':'summary', 'tool_calls':[{'id':'forbidden'}]}])
def test_invalid_candidates_do_not_advance_cursor(monkeypatch,response):
    seed(); before=checkpoint.summary_state()
    monkeypatch.setattr(llm,'chat_completion',lambda *a,**k:response)
    assert not compress.compress_once()
    assert checkpoint.summary_state()==before


def test_summary_exception_keeps_original(monkeypatch):
    seed();before=checkpoint.live_messages()
    def fail(*a,**k):raise llm.LlmError('simulated unavailable provider')
    monkeypatch.setattr(llm,'chat_completion',fail)
    with pytest.raises(llm.LlmError):compress.compress_once()
    assert checkpoint.live_messages()==before
    assert checkpoint.summary_state()['cursor']==-1


def test_inflight_compaction_does_not_block_safe_guard(monkeypatch):
    from app.core import state
    seed(); entered=threading.Event(); release=threading.Event()
    def slow(*a,**k):
        entered.set();assert release.wait(3)
        return {'content':'We planned a garden visit.'}
    monkeypatch.setattr(llm,'chat_completion',slow)
    assert compress.maybe_compress(10**9)
    try:
        assert entered.wait(1)
        compress.guard_request(state.load()['settings']['llm'],[{'role':'user','content':'Hello'}],[],cancelled=lambda:False)
        assert not release.is_set()
    finally:
        release.set();assert compress._done.wait(3)


def test_candidate_rejected_after_source_suppression(monkeypatch):
    from app.core import db
    seed()
    def forgotten(*a,**k):
        source=checkpoint.context_rows(limit=None)[0]['event_id']
        with db.tx() as c:c.execute('INSERT INTO suppressed_sources(event_id,forgotten_at) VALUES(?,?)',(source,db.now_iso()))
        return {'content':'stale garden visit'}
    monkeypatch.setattr(llm,'chat_completion',forgotten)
    assert not compress.compress_once()
    assert not checkpoint.live_summary()
