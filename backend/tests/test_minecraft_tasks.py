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
