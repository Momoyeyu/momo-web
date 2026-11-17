import base64
import io
import json
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


def test_discard_observation_does_not_remove_another_runs_frame():
    token=current_run.set('discard-this')
    own,other=object(),object()
    try:
        tools._pending['discard-this']=own
        tools._pending['keep-other']=other
        tools.discard_observation()
        assert 'discard-this' not in tools._pending
        assert tools._pending['keep-other'] is other
    finally:
        tools._pending.pop('discard-this',None);tools._pending.pop('keep-other',None);current_run.reset(token)


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


def test_active_tool_frame_refits_after_large_inventory_receipt(monkeypatch):
    from types import SimpleNamespace
    from app.core import state
    from app.services import turn, checkpoint
    from app.services.context_policy import Budget
    cfg=state.load(); cfg['settings']['llm'].update(contextWindow=32768,maxOutputTokens=4096)
    monkeypatch.setattr(turn,'TOOLS',[])
    monkeypatch.setattr(tools,'declarations',lambda *_:[])
    monkeypatch.setattr(tools,'require_local',lambda **_: 'active-inventory')
    monkeypatch.setattr(tools.state,'load',lambda:cfg)
    monkeypatch.setattr(vision,'require_enabled',lambda *_:None)
    raw=io.BytesIO();Image.new('RGB',(1536,1536),'white').save(raw,'PNG')
    seen=[]
    def provider(_cfg,messages,**kwargs):
        seen.append(messages)
        if len(seen)==1:
            yield {'type':'tool_calls','calls':[{'id':'inventory','type':'function','function':{'name':'minecraft_action','arguments':'{"action":"observe"}'}}]}
        else:
            yield {'type':'text','delta':'Verified.'}
    monkeypatch.setattr(checkpoint,'append_sentence',lambda *args:True)
    monkeypatch.setattr(checkpoint,'event_metadata',lambda *args:{})
    def receipt(call,ext):
        tools.stage(raw.getvalue(),lambda:None)
        return {'role':'tool','tool_call_id':'inventory','content':'J'*10000}
    monkeypatch.setattr(turn.llm,'chat_stream',provider)
    monkeypatch.setattr(turn,'run_call',receipt)
    messages=[{'role':'system','content':'H'*(Budget.from_config(cfg['settings']['llm']).safe-20000)}]
    token=current_run.set('active-inventory')
    try:
        events=list(turn.react(messages,SimpleNamespace(decls=[]),cfg,checkpoint.generation(),'fixture'))
        assert not [e for e in events if e['t']=='error']
        assert len(seen)==2
        url=seen[-1][-1]['content'][1]['image_url']['url']
        assert Image.open(io.BytesIO(base64.b64decode(url.split(',')[1]))).size==(1024,1024)
    finally:
        tools._pending.pop('active-inventory',None);current_run.reset(token)


def test_bound_game_exposes_only_its_observation_lane():
    from app.services.minecraft import minecraft
    with patch.object(tools,'require_local',return_value='r'), patch.object(minecraft,'binding',{'world':'fixture'}), patch.object(minecraft,'permissions',{'game.observe','game.modify'}), patch('app.services.activities.snapshot',return_value={'enabled':{'computer':True,'browser':True,'minecraft':True}}):
        names={row['function']['name'] for row in tools.declarations()}
        assert 'minecraft_action' in names
        assert not names & {'screen_observe','computer_targets','computer_request'}

@pytest.mark.parametrize('permissions,allowed',[({'game.observe','game.move'},False),({'game.observe','game.modify'},True)])
def test_follow_tool_matches_unified_body_authority(permissions,allowed):
 from app.services.minecraft import minecraft
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'binding',{'world':'fixture'}),patch.object(minecraft,'permissions',permissions),patch('app.services.activities.snapshot',return_value={'enabled':{'computer':True,'browser':True,'minecraft':True}}):
  declaration=next(row['function'] for row in tools.declarations() if row['function']['name']=='minecraft_action')
  assert ('follow' in declaration['parameters']['properties']['action']['enum']) is allowed


def test_desktop_observation_cannot_steal_bound_game_attention():
    from app.services.computer import Computer, ComputerError
    from app.services.minecraft import minecraft
    computer=Computer()
    with patch('app.services.activities.require_enabled'), patch.object(minecraft,'binding',{'world':'fixture'}), patch.object(tools.state,'load',return_value={'settings':{'llm':{}}}), patch.object(tools.runtime,'started',True), patch.object(tools.runtime,'mode','meeting'), patch.object(tools.runtime,'focus',False), patch.object(tools.runtime,'restoring',False), patch.object(vision,'require_enabled'):
        with pytest.raises(ComputerError,match='attention'):
            computer.desktop_frame()
        assert not computer.observing
        assert minecraft.binding == {'world':'fixture'}

def test_new_game_observation_retires_only_old_read_snapshot_not_action_receipts():
 old={'observedAt':123,'x':1,'y':64,'z':2,'visibleEntities':[{'name':'x'*12000}]}
 calls=[{'id':'read','function':{'name':'minecraft_action','arguments':'{"action":"observe"}'}},
        {'id':'move','function':{'name':'minecraft_action','arguments':'{"action":"submit"}'}}]
 messages=[{'role':'assistant','tool_calls':calls},
           {'role':'tool','tool_call_id':'read','content':json.dumps(old)},
           {'role':'tool','tool_call_id':'move','content':'{"task":{"state":"succeeded","evidence":{"x":2}}}'}]
 action=dict(messages[2])
 tools.retire_game_observations(messages)
 assert messages[2]==action
 retired=json.loads(messages[1]['content'])
 assert retired['observedAt']==123 and retired['x']==1 and retired['superseded']
 assert 'visibleEntities' not in retired and len(messages[1]['content'])<500

def test_compaction_refresh_does_not_restore_retired_large_game_snapshot():
 from app.services.turn import ContextMessages
 event={'role':'system','content':tools.GAME_EVENT_PREFIX+json.dumps({'observedAt':1,'x':2,'visibleEntities':['x'*12000]})}
 messages=ContextMessages([dict(event)]);messages.base_count=1
 messages.rebuild=lambda:[dict(event)]
 tools.retire_game_observations(messages)
 messages.refresh()
 assert len(messages[0]['content'])<1000 and 'superseded' in messages[0]['content']

def test_retiring_known_read_keeps_a_conservative_measured_prefix_bound():
 import copy
 from app.services.turn import ContextMessages
 from app.services.context_policy import estimate_request,estimate
 event={'role':'system','content':tools.GAME_EVENT_PREFIX+json.dumps({'observedAt':1,'x':2,'visibleEntities':['x'*12000]})}
 messages=ContextMessages([{'role':'system','content':'unchanged'*5000},event])
 definitions=[{'type':'function','function':{'name':'minecraft_action'}}]
 messages.usage_anchor=(copy.deepcopy(list(messages)),definitions,5000)
 tools.retire_game_observations(messages)
 assert messages.usage_anchor[0]==messages
 assert messages.usage_anchor[2]>5000, 'replacement text is charged; removed text is not discounted'
 assert estimate_request(messages,definitions)<estimate(messages,definitions)
 charged=messages.usage_anchor[2]
 tools.retire_game_observations(messages)
 assert messages.usage_anchor[2]==charged, 'idempotent retirement must not charge twice'
 messages[0]['content']='unmeasured change'
 tools.retire_game_observations(messages)
 assert estimate_request(messages,definitions)==estimate(messages,definitions)

def test_game_model_projection_keeps_slot_addresses_and_requests_recipes_on_demand():
 from app.services.minecraft import Minecraft
 raw={'observedAt':1,'x':2,'slots':[{'id':0,'item':'minecraft:air','count':0,'components':{}},
                                   {'id':9,'item':'minecraft:oak_log','count':4,'name':'橡木原木'}],
      'knownRecipes':[{'id':'minecraft:oak_planks','ingredients':['x'*10000]}],
      'task':{'state':'failed','evidence':{'blocksBroken':1}}}
 result=Minecraft.model_observation(raw)
 assert result['slots']==[{'id':0,'empty':True},raw['slots'][1]]
 assert 'knownRecipes' not in result and result['recipeQueryAvailable']
 assert result['task']==raw['task'] and 'knownRecipes' in raw

def test_game_goal_conflict_reports_recovery_instead_of_an_ambiguous_permission_failure():
 from app.services.minecraft import minecraft,MinecraftError
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'update_goal',side_effect=MinecraftError('Live task must settle',code='MINECRAFT_TASKS_ACTIVE')):
  result=json.loads(tools.execute('minecraft_goal',{}))
 assert result['code']=='MINECRAFT_TASKS_ACTIVE' and 'cancel' in result['error'].lower()

@pytest.mark.parametrize('arguments',[
 {'action':'submit','taskId':'work','args':{'steps':[{'skill':'wait','args':{'ticks':20}}]}},
 {'action':'wait','args':{'ticks':20}},
 {'action':'play','control':'forward','durationMs':0},
])
def test_game_parameter_errors_are_known_before_dispatch(arguments):
 from app.services.minecraft import minecraft
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'execute') as dispatch:
  reply=json.loads(tools.execute('minecraft_action',arguments))
 assert reply['code']=='MINECRAFT_INPUT'
 assert 'skill' in reply['error']
 dispatch.assert_not_called()

@pytest.mark.parametrize('action',['submit','cancel','resume'])
def test_historical_activity_on_a_game_action_explains_the_read_only_field(action):
 from app.services.minecraft import minecraft
 arguments={'action':action,'activityId':'old','taskId':'next','skill':'wait','args':{'ticks':20}}
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'execute') as dispatch:
  reply=json.loads(tools.execute('minecraft_action',arguments))
 assert reply['code']=='MINECRAFT_HISTORY_READ_ONLY'
 assert 'activityId' in reply['error'] and 'action="task"' in reply['error']
 dispatch.assert_not_called()

def test_declared_game_escape_key_passes_the_shared_action_schema():
 from app.services.minecraft import minecraft
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'execute',return_value={'sent':True}) as dispatch:
  reply=json.loads(tools.execute('minecraft_action',{'action':'play','control':'screenKey','key':'escape','durationMs':1}))
 assert reply=={'sent':True}
 assert dispatch.call_args.args[1]['key']=='escape'

def test_game_observation_omits_default_slot_metadata_but_preserves_durability_and_food():
 import copy
 from app.services.minecraft import Minecraft
 raw={'slots':[{'id':9,'item':'minecraft:oak_log','count':3,'damage':0,'maxDamage':0,'components':{}},
               {'id':41,'item':'minecraft:wooden_sword','count':1,'damage':7,'maxDamage':59,'components':{'minecraft:enchantments':'sharpness level 1'}},
               {'id':36,'item':'minecraft:rotten_flesh','count':3,'damage':0,'maxDamage':0,'components':{'minecraft:food':'nutrition=4, hunger effect'}}]}
 old=copy.deepcopy(raw);projected=Minecraft.model_observation(raw)
 assert projected['slots'][0]=={'id':9,'item':'minecraft:oak_log','count':3}
 assert projected['slots'][1]==raw['slots'][1]
 assert projected['slots'][2]['components']==raw['slots'][2]['components']
 assert raw==old

def test_live_game_projection_bounds_metadata_without_losing_vanilla_inventory_addresses():
 import copy
 from app.services.minecraft import Minecraft
 raw={'world':'w','account':'a','observedAt':123456789,'epoch':77,'x':1.123456789,'y':64,'z':2.987654321,'health':17,'food':15,'screen':'world','selectedHotbar':0,
      'slots':[{'id':i,'item':'minecraft:oak_planks','count':i+1,'name':'橡木木板','components':{'minecraft:enchantments':'long evidence '*70}} for i in range(9,46)],
      'visibleLandmarks':[{'x':i,'y':65,'z':3,'block':'minecraft:oak_log','distance':i+.123456789} for i in range(24)]}
 before=copy.deepcopy(raw);projected=Minecraft.model_observation(raw,compact=True)
 assert len(json.dumps(projected,ensure_ascii=False,separators=(',',':')).encode())<=6000
 assert [(s['id'],s['item'],s['count']) for s in projected['slots']]==[(s['id'],s['item'],s['count']) for s in raw['slots']]
 assert projected['observedAt']==raw['observedAt'] and projected['epoch']==77 and projected['health']==17
 assert projected['detailsAvailable'] and raw==before
 detail=Minecraft.model_observation(raw,compact=True,query='slot:12')
 assert detail['slots']==[raw['slots'][3]] and detail['world']=='w'
 assert Minecraft.model_observation(raw,compact=True,query='details')['slots']==raw['slots']

def test_game_declaration_keeps_semantic_tasks_small_and_manual_controls_on_demand():
 declaration=tools._minecraft_declaration(['observe','submit','capabilities','play'])['function']
 assert set(declaration['parameters']['properties'])=={'action','query','taskId','activityId','skill','args','after'}
 assert 'controls' in declaration['description'] and 'args' in declaration['description']

@pytest.mark.parametrize("station_preparation",[False,True])
@pytest.mark.parametrize("station_placement",[False,True])
def test_full_game_catalog_leaves_context_for_goal_and_current_pixels(station_preparation,station_placement):
 from pathlib import Path
 from typing import get_args
 from app.api.minecraft import Action,TaskCommand
 from app.services.minecraft import minecraft
 definitions=json.loads((Path(__file__).parents[2]/'plugin-host/src/minecraft-skills.json').read_text())
 with patch.object(minecraft,'capabilities',{'skillDefinitions':definitions,'craftStationPreparation':station_preparation,'craftStationPlacement':station_placement}):
  actions=sorted({'stop',*get_args(Action.model_fields['action'].annotation),*get_args(TaskCommand.model_fields['action'].annotation)})
  declaration=tools._minecraft_declaration(actions)
 assert len(json.dumps(declaration,ensure_ascii=False).encode())<=3000
 description=declaration['function']['description']
 assert all(name+'(' in description for name in definitions), 'Keep every actual skill discoverable'
 assert 'taskId' in description and 'same' in description.lower()

def test_nested_manual_fallback_uses_the_same_validated_input_and_authority():
 from app.services.minecraft import minecraft
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'execute',return_value={'sent':True}) as dispatch:
  reply=json.loads(tools.execute('minecraft_action',{'action':'play','args':{'control':'screenKey','key':'escape','durationMs':1}}))
 assert reply=={'sent':True} and dispatch.call_args.args[1]['control']=='screenKey' and dispatch.call_args.args[1]['key']=='escape'
 with patch.object(tools,'require_local',return_value='r'),patch.object(minecraft,'execute') as dispatch:
  for args in [{'control':'look','generation':99},{'control':'look','leaseId':'fake'},{'control':'forward','durationMs':0}]:
   assert json.loads(tools.execute('minecraft_action',{'action':'play','args':args}))['code']=='MINECRAFT_INPUT'
 dispatch.assert_not_called()


@pytest.mark.parametrize('query',['inventory','terrain','entities','station','chat','slot:12'])
def test_focused_game_read_returns_fresh_state_without_staging_or_reserving_another_image(query):
 from app.services.minecraft import minecraft
 from app.services.context_policy import Budget, estimate
 raw={'observedAt':time.time()*1000,'world':'w','account':'a','health':20,'slots':[{'id':12,'item':'minecraft:oak_log','count':4}],
      'visibleBlocks':[{'x':1,'y':64,'z':2,'block':'minecraft:stone'}],'frame':'data:image/png;base64,'+base64.b64encode(pixels()).decode()}
 with patch.object(tools,'require_local',return_value='state-read'),patch.object(minecraft,'execute',return_value=raw) as execute,patch.object(tools,'stage') as stage:
  call={'id':'read','function':{'name':'minecraft_action','arguments':json.dumps({'action':'observe','query':query})}}
  assert tools.capture_budget(call)==[]
  result=json.loads(tools.execute('minecraft_action',{'action':'observe','query':query}))
 assert execute.call_args.args[1]=={'frame':False}
 assert result['observedAt']==raw['observedAt'] and result['health']==20
 assert not result.get('pixelsFollow') and 'frame' not in result
 stage.assert_not_called()
 if query in {'inventory','slot:12'}:assert result['slots'][0]['count']==4
 if query=='terrain':assert result['visibleBlocks']==raw['visibleBlocks']


def test_unfocused_game_observe_still_reserves_and_returns_a_real_image():
 from app.services.minecraft import minecraft
 raw={'observedAt':time.time()*1000,'frame':'data:image/png;base64,'+base64.b64encode(pixels()).decode()}
 with patch.object(tools,'require_local',return_value='visual-read'),patch.object(minecraft,'execute',return_value=raw) as execute,patch.object(tools,'stage') as stage:
  call={'id':'read','function':{'name':'minecraft_action','arguments':'{"action":"observe"}'}}
  assert tools.capture_budget(call)
  result=json.loads(tools.execute('minecraft_action',{'action':'observe'}))
 assert execute.call_args.args[1]=={'frame':True}
 assert result['pixelsFollow'] is True
 stage.assert_called_once()


@pytest.mark.parametrize('supported',[None,False,'true',True])
def test_native_workbench_preparation_is_not_advertised_to_old_clients(supported):
 from app.services.minecraft import minecraft
 capabilities={'skillDefinitions':{'craft':{'parameters':{'properties':{'recipe':{},'count':{}}}}}}
 if supported is not None:capabilities['craftStationPreparation']=supported
 with patch.object(minecraft,'capabilities',capabilities):
  declaration=tools._minecraft_declaration(['submit','capabilities'])['function']
 assert ('auto-opens' in declaration['description']) is (supported is True)

@pytest.mark.parametrize('preparation',[False,True])
@pytest.mark.parametrize('placement',[None,False,'true',True])
def test_carried_station_is_only_advertised_when_the_body_supports_placement(preparation,placement):
 from app.services.minecraft import minecraft
 capabilities={'craftStationPreparation':preparation,'craftStationPlacement':placement,
               'skillDefinitions':{'craft':{'parameters':{'properties':{'recipe':{},'count':{}}}}}}
 with patch.object(minecraft,'capabilities',capabilities):
  description=tools._minecraft_declaration(['submit','capabilities'])['function']['description']
 assert ('places owned' in description) is (preparation is True and placement is True)
