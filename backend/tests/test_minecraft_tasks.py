import threading,time
from types import SimpleNamespace
from unittest.mock import Mock,patch
import pytest
from app.services.minecraft import Minecraft,MinecraftError

def setup():
 m=Minecraft();m.binding={'world':'world','account':'player'};m.permissions={'game.observe','game.modify'};m.epoch=7;m.fingerprint='cfg';m.owner=('owner','lease');m.capabilities={'taskProtocol':1,'skills':['navigate']}
 rt=SimpleNamespace(host=SimpleNamespace(control=threading.RLock(),request=Mock(return_value={'task':{'taskId':'t1','state':'queued','evidence':{}}})),epoch=7,owner={'clientId':'owner','leaseId':'lease','expiresAt':time.monotonic()+15},started=True,mode='meeting',focus=False,restoring=False)
 return m,rt

def test_submit_uses_current_binding_without_waiting_for_completion():
 m,rt=setup()
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'),patch.object(m,'record_tasks'):
  result=m.execute('submit',{'taskId':'t1','skill':'navigate','args':{'x':1,'y':64,'z':2}},0,'owner','lease')
  assert result['task']['state']=='queued'
  assert rt.host.request.call_args.args[0]=='minecraft.submit'
  assert rt.host.request.call_args.args[1]['permission']=={'world':'world','account':'player','activityEpoch':7}

def test_background_body_lease_does_not_need_a_model_run_and_cannot_outlive_owner():
 m,rt=setup();rt.host.request.return_value={'events':{'cursor':1,'gap':False,'events':[]}}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'_background_valid',return_value=True),patch.object(m,'record_tasks'):
  m.poll_tasks(0)
  assert [call.args[0] for call in rt.host.request.call_args_list]==['minecraft.heartbeat','minecraft.events']
  rt.host.request.reset_mock()
  with patch.object(m,'_background_valid',return_value=False):m.poll_tasks(0)
  assert not any(c.args[0]=='minecraft.heartbeat' for c in rt.host.request.call_args_list)
  assert m.binding is None

def test_event_gap_reconciles_snapshot_instead_of_replaying_mutations():
 m,rt=setup()
 rt.host.request.side_effect=[{}, {'events':{'cursor':300,'gap':True,'events':[]}}, {'tasks':[{'taskId':'t1','state':'succeeded','evidence':{'arrived':True}}]}]
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'_background_valid',return_value=True),patch.object(m,'record_tasks') as record:
  m.poll_tasks(0)
  assert [c.args[0] for c in rt.host.request.call_args_list]==['minecraft.heartbeat','minecraft.events','minecraft.task']
  record.assert_called_once()
  assert m.cursor==300

def test_gameplay_mutation_requires_unified_play_permission():
 m,rt=setup();m.permissions={'game.observe'}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  with pytest.raises(MinecraftError,match='denied'):m.execute('submit',{'taskId':'x'},0,'owner','lease')
  rt.host.request.assert_not_called()

def test_goal_recheck_is_event_driven_with_a_30_second_idle_floor():
 m,rt=setup();m.autonomous=True;m.decision_needed=True
 rt.active=rt.presentation=None;rt.queue=[];rt.interrupt_hold=False
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'),patch('app.services.intro.restricted',return_value=False),patch('app.services.minecraft.time.monotonic',return_value=100):
  assert m.claim_decision(0,'owner','lease')['kind']=='minecraft'
  assert m.claim_decision(0,'owner','lease') is None
  with patch('app.services.minecraft.time.monotonic',return_value=120):assert m.claim_decision(0,'owner','lease') is None
  with patch('app.services.minecraft.time.monotonic',return_value=130):assert m.claim_decision(0,'owner','lease')
  m.decision_needed=True
  with patch('app.services.minecraft.time.monotonic',return_value=133):assert m.claim_decision(0,'owner','lease')
  rt.active='player-conversation'
  with patch('app.services.minecraft.time.monotonic',return_value=170):assert m.claim_decision(0,'owner','lease') is None

def test_model_capabilities_are_bounded_and_schemas_are_requested_per_skill():
 m,rt=setup()
 definitions={'navigate':{'description':'Reach known position','parameters':{'type':'object','properties':{'x':{'type':'integer'}}}},'craft':{'description':'Craft an item','parameters':{'type':'object','properties':{'recipe':{'type':'string'}}}}}
 rt.host.request.return_value={'taskProtocol':1,'skills':list(definitions),'skillDefinitions':definitions}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  small=m.execute('capabilities',{},0,None,None)
  assert 'skillDefinitions' not in small
  selected=m.execute('capabilities',{'skill':'craft'},0,None,None)
  assert selected['skillDefinitions']=={'craft':definitions['craft']}

def test_verified_stop_records_original_completed_receipt_even_after_clearing_authority():
 from app.services import minecraft_journal as journal
 m,rt=setup()
 rt.host.request.return_value={'stopped':True,'stopVerified':True,'retiredTasks':[{'taskId':'owned','skill':'navigate','state':'succeeded','evidence':{'arrived':True}}]}
 binding=dict(m.binding)
 with patch('app.services.minecraft.runtime',rt):m.stop()
 assert m.binding is None
 assert journal.recent(binding)[0]['state']=='succeeded'

def test_unknown_transport_revokes_binding_but_invalid_input_does_not():
 from app.core.plugin_host import HostError
 m,rt=setup()
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  rt.host.request.side_effect=HostError('MINECRAFT_INPUT')
  with pytest.raises(HostError):m.execute('submit',{},0,None,None)
  assert m.binding
  rt.host.request.side_effect=[HostError('MINECRAFT_UNKNOWN'),{'stopped':True,'stopVerified':True}]
  with pytest.raises(HostError):m.execute('submit',{},0,None,None)
  assert m.binding is None

def test_focus_releases_game_body_immediately_without_cancelling_the_local_conversation():
 from app.services.coordinator import Coordinator
 from app.services.minecraft import minecraft
 c=Coordinator()
 with patch.object(c,'require_meeting'),patch.object(c,'_persist_attention_policy'),patch.object(c,'_release_held'),patch.object(minecraft,'binding',{'world':'w','account':'p'}),patch.object(minecraft,'stop',return_value={'stopVerified':True}) as stop:
  c.control('owner','lease','focus-request','focus_on')
  stop.assert_called_once()
  assert c.focus

def test_pausing_goal_pauses_body_before_persisting_intention():
 m,rt=setup();m.autonomous=True
 value={'title':'看花','reason':'好奇','source':'curiosity','expected':'见到花','status':'paused'}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  m.update_goal(value)
  assert m.paused and not m.autonomous
  assert rt.host.request.call_args.args[0]=='minecraft.pause'
  assert m.current_goal()['status']=='paused'

def test_goal_cannot_claim_completion_or_replace_intent_while_body_task_is_live():
 m,rt=setup();m.tasks={'t1':{'taskId':'t1','state':'running'}}
 value={'title':'看花','reason':'好奇','source':'curiosity','expected':'见到花','status':'completed'}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  with pytest.raises(MinecraftError,match='live task'):m.update_goal(value)
  assert m.current_goal() is None

def test_goal_activation_never_undoes_manual_takeover_pause():
 m,rt=setup();m.paused=True
 value={'title':'看花','reason':'好奇','source':'curiosity','expected':'见到花','status':'active'}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  m.update_goal(value)
  assert m.paused and not m.autonomous
  rt.host.request.assert_not_called()

def test_unfocused_game_suspends_decisions_without_revoking_or_mistaking_it_for_a_failure():
 m,rt=setup();m.autonomous=True;m.decision_needed=True
 rt.active=rt.presentation=None;rt.queue=[];rt.interrupt_hold=False
 rt.host.request.side_effect=[{'suspended':True},{'events':{'cursor':0,'gap':False,'events':[]}}]
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'),patch.object(m,'_background_valid',return_value=True),patch('app.services.intro.restricted',return_value=False):
  m.poll_tasks(0)
  assert m.binding and m.suspended and m.claim_decision(0,'owner','lease') is None
  rt.host.request.side_effect=[{'suspended':False},{'events':{'cursor':0,'gap':False,'events':[]}}]
  m.poll_tasks(0)
  assert not m.suspended and m.claim_decision(0,'owner','lease')
