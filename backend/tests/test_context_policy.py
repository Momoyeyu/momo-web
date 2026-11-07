import pytest
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


def test_screenshot_reservation_triggers_real_guard_refresh_without_summarizing_pixels(monkeypatch):
    import math
    from app.services import compress, turn
    from app.core import state, llm
    from conftest import add_turn
    from tests.test_checkpoint import _InlineThread
    cfg = state.load()
    cfg['settings']['llm']['maxOutputTokens'] = 1000
    for i in range(30): add_turn('q'*300, 'a'*300, at=str(i))
    messages = turn.build_messages(cfg, 'look at the approved window')
    tool_pair = [{'role':'assistant','content':None,'tool_calls':[{'id':'observe-1','type':'function','function':{'name':'computer_observe','arguments':'{}'}}]}, {'role':'tool','tool_call_id':'observe-1','content':'{"pixelsFollow":true}'}]
    messages.extend(tool_pair)
    cfg['settings']['llm']['contextWindow'] = math.ceil((estimate(messages)+1500)/.92)
    reservation = [{'role':'user','content':[{'type':'image_url','image_url':{'url':'momo-observation:pending'},'vision_tokens':4096}]}]
    assert estimate(messages) < Budget.from_config(cfg['settings']['llm']).safe
    assert estimate([*messages,*reservation]) > Budget.from_config(cfg['settings']['llm']).safe
    monkeypatch.setattr(compress,'load_state',lambda:cfg)
    monkeypatch.setattr(compress,'Thread',_InlineThread)
    requests = []
    def summarize(*args, **kwargs):
        requests.append(args[1])
        assert 'momo-observation:' not in str(args[1])
        return {'content':'old experiences'}
    monkeypatch.setattr(llm,'chat_completion',summarize)
    compress.guard_request(cfg['settings']['llm'],messages,[],cancelled=lambda:False,extra_messages=reservation)
    assert requests
    assert estimate([*messages,*reservation]) <= Budget.from_config(cfg['settings']['llm']).safe
    assert messages[-3]['content'] == 'look at the approved window'
    assert messages[-2:] == tool_pair


@pytest.mark.parametrize("expired", [False, True])
@pytest.mark.parametrize("soft_worker_finishing", [False, True])
def test_hard_guard_compacts_when_every_candidate_exceeds_soft_but_fits_safe(monkeypatch,request,expired,soft_worker_finishing):
    from app.services import compress, turn, checkpoint, computer_tools, vision
    from app.services.coordinator import current_run
    from test_computer_tools import pixels
    from app.core import state, llm
    from conftest import add_turn
    from tests.test_checkpoint import _InlineThread
    cfg=state.load()
    cfg['settings']['llm'].update(contextWindow=32768,maxOutputTokens=4096)
    monkeypatch.setattr(compress,'load_state',lambda:cfg)
    monkeypatch.setattr(turn,'build_system_prompt',lambda *a,**k:'Header '*2200)
    for i in range(18):add_turn('q'*300,'a'*300,at=str(i))
    messages=turn.build_messages(cfg,'current question')
    pair=[{'role':'assistant','content':None,'tool_calls':[{'id':'c1','type':'function','function':{'name':'computer_observe','arguments':'{}'}}]}, {'role':'tool','tool_call_id':'c1','content':'{"pixelsFollow":true}'}]
    messages.extend(pair)
    token=current_run.set('hard-budget-fixture')
    request.addfinalizer(lambda:current_run.reset(token))
    monkeypatch.setattr(computer_tools,'require_local',lambda:'hard-budget-fixture')
    monkeypatch.setattr(vision,'require_enabled',lambda *_:None)
    computer_tools.stage(pixels(),lambda:None)
    reservation=computer_tools.observation_budget()
    budget=Budget.from_config(cfg['settings']['llm'])
    assert budget.safe==26050 and budget.soft==18841
    assert estimate([*messages,*reservation])>budget.safe
    summaries=[]
    def summarize(*args,**kwargs):
        summaries.append(args[1]);assert 'momo-observation:' not in str(args[1])
        if expired:
            # Simulate the existing timer expiring while the summary is generated.
            computer_tools._pending.pop('hard-budget-fixture',None)
        return {'content':'old experiences'}
    monkeypatch.setattr(llm,'chat_completion',summarize)
    monkeypatch.setattr(compress,'Thread',_InlineThread)
    if soft_worker_finishing:
        original=compress.maybe_compress
        attempts=[]
        def finish_soft_first(*args,**kwargs):
            attempts.append(kwargs.get('hard'))
            if len(attempts)==1:return False
            return original(*args,**kwargs)
        monkeypatch.setattr(compress,'maybe_compress',finish_soft_first)
    compress.guard_request(cfg['settings']['llm'],messages,[],cancelled=lambda:False,extra_messages=reservation)
    if soft_worker_finishing:assert attempts==[True,True]
    assert summaries
    assert messages[-2:]==pair
    assert messages[-3]['content']=='current question'
    assert estimate([*messages,*reservation])<=budget.safe
    assert checkpoint.summary_state()['cursor']>=0

    if expired:
        with pytest.raises(vision.VisionError,match='computer.observationExpired'):
            computer_tools.project(messages,cfg['settings']['llm'],require_observation=True)
    else:
        assert len(computer_tools.project(messages,cfg['settings']['llm'],require_observation=True))==len(messages)+1


def test_emergency_selection_keeps_soft_policy_and_additional_safe_reserve():
    from app.services.context_policy import Policy
    budget=Budget.from_config({'contextWindow':32768,'maxOutputTokens':4096})
    rows=[{'run_id':str(i),'role':'user','text':'x'*300} for i in range(18)]
    policy=Policy({},'owner')
    assert policy.select(rows,budget,16722) is None
    assert policy.select(rows,budget,16722,hard=True) in range(2,9)
    assert policy.select(rows,budget,budget.safe-655,hard=True) is None

def test_hard_capture_budget_replaces_old_summary_instead_of_counting_both(monkeypatch):
    from app.core import state, db, llm
    from app.services import compress, turn, checkpoint
    from conftest import add_turn
    from tests.test_checkpoint import _InlineThread
    cfg=state.load()
    cfg['settings']['llm'].update(contextWindow=32768,maxOutputTokens=4096)
    for i in range(8):add_turn('q'*180,'a'*180,at=str(i))
    old=('Earlier shared experiences. '*210).strip()
    with db.tx() as c:c.execute('UPDATE sessions SET summary=? WHERE id=?',(old,db.LIVE_ID))
    monkeypatch.setattr(compress,'load_state',lambda:cfg)
    monkeypatch.setattr(turn,'build_system_prompt',lambda *a,**k:'H'*15000)
    messages=turn.build_messages(cfg,'Read the test window.')
    pair=[{'role':'assistant','content':None,'tool_calls':[{'id':'capture','type':'function','function':{'name':'computer_observe','arguments':'{}'}}]}]
    messages.extend(pair)
    reservation=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'momo-observation:pending'},'vision_tokens':3072}]}]
    assert estimate([*messages,*reservation])>Budget.from_config(cfg['settings']['llm']).safe
    requests=[]
    def summarize(config,prompt,**kwargs):
        requests.append(prompt)
        assert str(prompt).count(old)==1 and 'momo-observation:' not in str(prompt)
        return {'content':'Shared experiences and unfinished topics preserved.'}
    monkeypatch.setattr(llm,'chat_completion',summarize)
    monkeypatch.setattr(compress,'Thread',_InlineThread)
    compress.guard_request(cfg['settings']['llm'],messages,[],cancelled=lambda:False,extra_messages=reservation)
    assert requests and checkpoint.live_summary()!=old
    assert messages[-1:]==pair
    assert estimate([*messages,*reservation])<=Budget.from_config(cfg['settings']['llm']).safe
