import base64
import io
import time
from unittest.mock import patch
import pytest
from PIL import Image
from app.services import computer_tools as tools, vision
from app.services.coordinator import current_run


def pixels():
    out=io.BytesIO(); Image.new('RGB',(32,32),'red').save(out,'PNG'); return out.getvalue()


def test_remote_and_wrong_run_cannot_use_local_tools():
    token=current_run.set('r')
    try:
        with patch.object(tools,'runtime') as runtime, patch.object(tools.checkpoint,'audience',return_value='owner'):
            runtime.started=True; runtime.valid_run.return_value=True
            runtime.focus=runtime.restoring=runtime.interrupt_hold=False
            runtime.activity={'runId':'r','source':'qq'}
            with pytest.raises(ValueError): tools.require_local()
            assert tools.declarations('qq') == []
            runtime.activity={'runId':'other','source':'meeting'}
            with pytest.raises(ValueError): tools.require_local()
            runtime.activity={'runId':'r','source':'meeting'}
            assert tools.require_local() == 'r'
    finally: current_run.reset(token)


def test_ephemeral_pixels_only_enter_private_provider_payload_once():
    token=current_run.set('r')
    cfg={'model':'test'}
    try:
        with patch.object(tools,'require_local',return_value='r'), patch.object(vision,'require_enabled'), patch.object(tools.state,'load',return_value={'settings':{'llm':cfg}}):
            tools.stage(pixels(),lambda:None)
            transcript=[{'role':'tool','content':'{"pixelsFollow":true}','tool_call_id':'c'}]
            payload=tools.project(transcript,cfg)
            assert len(transcript)==1
            url=payload[-1]['content'][1]['image_url']['url']
            data=base64.b64decode(url.split(',')[1])
            assert Image.open(io.BytesIO(data)).size == (32,32)
            assert tools.project(transcript,cfg) is transcript
            assert 'base64' not in str(transcript)
    finally: current_run.reset(token)


def test_revocation_between_tool_and_provider_discards_pixels():
    token=current_run.set('r')
    try:
        with patch.object(tools,'require_local',return_value='r'):
            allowed=[True]
            def validate():
                if not allowed[0]: raise ValueError('revoked')
            tools.stage(pixels(),validate)
            allowed[0]=False
            with pytest.raises(vision.VisionError,match='revoked'): tools.project([],{'model':'test'})
            assert 'r' not in tools._pending
    finally: current_run.reset(token)


def test_minecraft_frame_is_stripped_and_staged_not_serialized():
    import json
    from app.services.minecraft import minecraft
    data=pixels()
    frame='data:image/png;base64,'+base64.b64encode(data).decode()
    with patch.object(tools,'require_local',return_value='r'), patch.object(minecraft,'execute',return_value={'frame':frame,'observedAt':time.time()*1000,'world':'fixture'}), patch.object(tools,'stage') as stage:
        result=json.loads(tools.execute('minecraft_action',{'action':'observe'}))
        assert 'frame' not in result
        assert result['pixelsFollow']
        assert 'base64' not in json.dumps(result)
        assert stage.call_args.args[0]==data


def test_native_failures_expose_only_reviewed_codes():
    import json
    from app.core.plugin_host import HostError
    from app.services.native_control import native_control
    with patch.object(tools, 'require_local', return_value='r'):
        for message, expected in [('SCREEN_PERMISSION_REQUIRED', 'SCREEN_PERMISSION_REQUIRED'), ('STALE_OBSERVATION', 'STALE_OBSERVATION'), ('INVALID_PERMIT', 'INVALID_PERMIT'), ('STALE_PERMIT', 'STALE_PERMIT'), ('PAUSED', 'PAUSED'), ('Plugin host timed out', 'NATIVE_TIMEOUT'), ('Plugin host disconnected', 'NATIVE_DISCONNECTED'), ('secret /private/path token=fixture', 'NATIVE_UNAVAILABLE')]:
            with patch.object(native_control, 'execute', side_effect=HostError(message)):
                result = json.loads(tools.execute('computer_observe', {}))
                assert result['code'] == expected
                assert 'secret' not in json.dumps(result)


def test_expired_or_revoked_grant_exposes_safe_permission_code():
    import json
    from app.services.native_control import native_control
    for message, expected in [('Application permission revoked','APPLICATION_PERMISSION_REVOKED'), ('Application grant changed','APPLICATION_GRANT_CHANGED'), ('Local active owner run required','LOCAL_OWNER_RUN_REQUIRED'), ('vision.disabled','VISION_DISABLED')]:
        with patch.object(tools, 'require_local', return_value='r'), patch.object(native_control, 'execute', side_effect=ValueError(message)):
            assert json.loads(tools.execute('computer_observe', {}))['code'] == expected


def test_saved_image_and_screenshot_use_actual_cost_until_wire_materialization(monkeypatch):
    from app.services import checkpoint
    from app.services.context_policy import estimate, Budget
    cfg={'url':'https://fixture.invalid','model':'fixture','vision':True,'contextWindow':16000,'maxOutputTokens':1000}
    monkeypatch.setattr(vision,'require_enabled',lambda *_:None)
    monkeypatch.setattr(vision,'enabled',lambda *_:True)
    monkeypatch.setattr(tools.state,'load',lambda:{'settings':{'llm':cfg}})
    image=vision.store(pixels())
    messages=[{'role':'user','content':vision.parts('earlier image',[image['id']],audience='owner',cfg=cfg)}]
    token=current_run.set('budget-fixture')
    try:
        with patch.object(tools,'require_local',return_value='budget-fixture'):
            tools.stage(pixels(),lambda:None)
            assert estimate(messages) < Budget.from_config(cfg).safe
            result=tools.project(messages,cfg,materialize=True)
            assert len(result)==2
            assert all('vision_tokens' not in part for m in result for part in m['content'] if isinstance(part,dict))
    finally: current_run.reset(token)


def test_observation_reservation_excludes_pixels_and_real_overflow_still_fails(monkeypatch):
    from app.services.context_policy import estimate
    token=current_run.set('reserve-fixture')
    cfg={'contextWindow':2000,'maxOutputTokens':1000}
    monkeypatch.setattr(tools.state,'load',lambda:{'settings':{'llm':cfg}})
    monkeypatch.setattr(vision,'require_enabled',lambda *_:None)
    try:
        with patch.object(tools,'require_local',return_value='reserve-fixture'):
            tools.stage(pixels(),lambda:None)
            reserve=tools.observation_budget()
            assert 'base64' not in str(reserve)
            short=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,A'},'vision_tokens':2048}]}]
            long=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,'+'A'*100000},'vision_tokens':2048}]}]
            assert estimate(short)==estimate(long)
            with pytest.raises(vision.VisionError,match='computer.budget'): tools.project([],cfg,materialize=True)
    finally: current_run.reset(token)


def test_observation_expiring_during_compaction_cannot_silently_drop_pixels():
    token=current_run.set('expired-reservation')
    try:
        with pytest.raises(vision.VisionError,match='computer.observationExpired'):
            tools.project([],{},materialize=True,require_observation=True)
    finally: current_run.reset(token)


def test_reaction_downsampling_preserves_original_deadline_and_authorization(monkeypatch):
    from app.services.context_policy import Budget,estimate
    cfg={'contextWindow':32768,'maxOutputTokens':4096}
    data=io.BytesIO();Image.new('RGB',(1600,1600),'white').save(data,'PNG')
    token=current_run.set('reaction-budget')
    try:
        with patch.object(tools,'require_local',return_value='reaction-budget'):
            tools.stage(data.getvalue(),lambda:None)
            original=tools._pending['reaction-budget']
            messages=[{'role':'system','content':'H'*(Budget.from_config(cfg).safe-6000)}]
            tools.fit_observation(messages,cfg)
            reduced=tools._pending['reaction-budget']
            assert reduced[2:4]==(1024,1024)
            assert reduced[0]==original[0] and reduced[-1] is original[-1] and reduced[-2] is original[-2]
            assert estimate([*messages,*tools.observation_budget()])<=Budget.from_config(cfg).safe
    finally:
        tools._pending.pop('reaction-budget',None);current_run.reset(token)


def test_screen_sense_is_available_without_started_observation_or_app_grant():
    from app.services.computer import computer
    with patch.object(tools,'require_local',return_value='r'),patch.object(tools.runtime,'focus',False),patch('app.services.activities.snapshot',return_value={'enabled':{'computer':True}}),patch.object(computer,'desktop_allowed',True),patch.object(computer,'observing',False):
        assert 'screen_observe' in [t['function']['name'] for t in tools.declarations()]


def test_screen_permission_failure_is_system_permission_not_app_approval():
    import json
    from app.services.computer import computer
    from app.core.plugin_host import HostError
    with patch.object(tools,'require_local',return_value='r'),patch.object(computer,'desktop_frame',side_effect=HostError('SCREEN_PERMISSION_REQUIRED')):
        assert json.loads(tools.execute('screen_observe',{}))['code']=='SCREEN_PERMISSION_REQUIRED'

def test_browser_plugin_can_request_its_window_without_desktop_plugin():
    from app.services import activities, native_control
    with patch.object(tools, 'require_local', return_value='owner'), patch.object(activities, 'snapshot', return_value={'enabled':{'computer':False,'browser':True}}), patch.object(native_control.native_control, 'start', return_value={'approvalRequired':True}) as start:
        result=tools.execute('computer_request',{'windowId':123,'ownerPid':456,'permissions':['observe','interact']})
        assert __import__('json').loads(result)['approvalRequired']
        start.assert_called_once_with(123,456,['observe','interact'],None,None,'browser')
