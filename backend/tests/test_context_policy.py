from app.services.context_policy import Budget, estimate, choose_latest


def test_window_relative_budget_and_complete_payload():
    small, big = Budget.from_config({'contextWindow': 16000}), Budget.from_config({'contextWindow': 128000})
    assert small.soft < big.soft
    assert estimate([{'role':'user','content':'你好'}], [{'function':{'description':'x'*1000}}]) > 1000
    assert small.safe < small.window


def test_latest_never_splits_runs_and_has_bounds():
    rows=[{'run_id':str(i//3),'text':'a'} for i in range(36)]
    assert choose_latest(rows, 4) == 24
    assert choose_latest(rows, 99) == 0


def test_background_prefix_publish_preserves_new_suffix(monkeypatch):
    from app.services import compress, checkpoint
    from app.core import llm
    from conftest import add_turn
    for i in range(9):
        add_turn(f'question about shared day {i}', f'answer about shared day {i}', at=str(i))
    before = checkpoint.live_messages()
    def summary(*args, **kwargs):
        assert kwargs.get('tool_choice') == 'none'
        add_turn('new while compacting', 'new answer', at='new')
        return {'content':'shared experiences'}
    monkeypatch.setattr(llm, 'chat_completion', summary)
    assert compress.compress_once()
    assert checkpoint.live_messages()[:len(before)] == before
    assert checkpoint.context_rows(limit=None)[-1]['text'] == 'new answer'
    assert len({r['run_id'] for r in checkpoint.context_rows(limit=None)}) == 5


def test_configuration_change_discards_candidate(monkeypatch):
    from app.services import compress, checkpoint
    from app.core import llm, state
    from conftest import add_turn
    for i in range(8): add_turn('q', 'a', at=str(i))
    def summary(*args, **kwargs):
        cfg=state.load()
        cfg['settings']['llm']['model']='different'
        monkeypatch.setattr(compress, 'load_state', lambda:cfg)
        return {'content':'stale'}
    monkeypatch.setattr(llm,'chat_completion',summary)
    assert not compress.compress_once()
    assert not checkpoint.live_summary()


def test_guard_rebuilds_after_emergency_compaction(monkeypatch):
    from app.services import compress, turn
    from app.core import state, llm
    from conftest import add_turn
    from tests.test_checkpoint import _InlineThread
    cfg = state.load()
    cfg['settings']['llm']['contextWindow']=32000
    monkeypatch.setattr(compress,'load_state',lambda:cfg)
    for i in range(30): add_turn('q'*500, 'a'*500, at=str(i))
    messages=turn.build_messages(cfg,'latest question')
    monkeypatch.setattr(compress,'Thread',_InlineThread)
    monkeypatch.setattr(llm,'chat_completion',lambda *a,**k:{'content':'old experiences'})
    compress.guard_request(cfg['settings']['llm'],messages,[],cancelled=lambda:False)
    assert messages[-1]['content']=='latest question'
    assert any(m['content'].endswith('old experiences') for m in messages)
    assert estimate(messages) <= Budget.from_config(cfg['settings']['llm']).safe


def test_numeric_policy_persists_and_risk_is_immediate():
    from app.services.context_policy import Policy
    p=Policy({'model':'one'},'owner')
    p.start('attempt')
    p.observe(.99,risk=True)
    reloaded=Policy({'model':'one'},'owner')
    assert reloaded.data['risk_alpha']==2
    assert reloaded.latest()==3
    assert Policy({'model':'two'},'owner').data == {}


def test_unobserved_candidate_does_not_borrow_baseline_evidence():
    from app.services.context_policy import Policy
    p=Policy({'model':'risk-test'},'owner')
    p.data={'risk_beta':100,'settled_horizons':99,'candidates':{'4':{'beta':100}}}
    p.save()
    rows=[{'run_id':str(i), 'role':'user','text':'shared conversation'*50} for i in range(20)]
    assert p.select(rows,Budget.from_config({}))==4
    assert p.select(rows,Budget.from_config({}),overhead=100000) is None


def test_output_allowance_is_not_silently_lowered():
    assert Budget.from_config({'contextWindow':32000,'maxOutputTokens':12000}).output==12000
