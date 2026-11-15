import threading
from types import SimpleNamespace
from unittest.mock import Mock,patch
import pytest
from app.services.minecraft import Minecraft,MinecraftError
from app.services import minecraft_journal as journal
from app.core.plugin_host import HostError


def setup():
 m=Minecraft();m.binding={'world':'test-world','account':'test-player'};m.permissions={'game.observe','game.modify'};m.epoch=7;m.fingerprint='cfg';m.owner=('owner','lease')
 rt=SimpleNamespace(host=SimpleNamespace(control=threading.RLock(),request=Mock()),epoch=7)
 return m,rt,{'taskId':'stable-id','skill':'gather','args':{'item':'minecraft:oak_log','count':4}}


def test_first_reply_lost_retains_dispatch_intent_without_goal_and_never_resubmits():
 m,rt,command=setup();binding=dict(m.binding);activity=m.activity_id
 def request(method,params=None):
  if method=='minecraft.submit':
   rows=journal.history(binding,activity=activity)
   assert len(rows)==1 and rows[0]['taskId']=='stable-id'
   assert rows[0]['dispatch']=='pending' and rows[0]['request']=={'skill':'gather','args':command['args']}
   raise HostError('MINECRAFT_UNKNOWN')
  return {'stopVerified':True}
 rt.host.request.side_effect=request
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  with pytest.raises(HostError):m.execute('submit',command,0,'owner','lease')
 assert m.binding is None
 row=journal.history(binding,activity=activity)[0]
 assert row['state']=='unknown' and row['dispatch']=='unknown' and not row['evidence']
 # Explicit fresh binding may inspect the old activity but never replay its effects.
 m.binding=binding;m.permissions={'game.observe'};m.epoch=7;m.activity_id='fresh-binding';rt.host.request.reset_mock()
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  result=m.execute('task',{'activityId':activity,'taskId':'stable-id'},m.generation,'owner','lease')
 assert result['task']['activityId']==activity and result['task']['state']=='unknown'
 rt.host.request.assert_not_called()
 assert journal.history({**binding,'account':'other'})==[]


def test_same_unknown_id_and_payload_cannot_be_replayed_and_conflicts_are_rejected():
 m,rt,command=setup();binding=dict(m.binding)
 rt.host.request.side_effect=HostError('MINECRAFT_UNKNOWN')
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'),patch.object(m,'stop'):
  with pytest.raises(HostError):m.execute('submit',command,0,'owner','lease')
  rt.host.request.reset_mock()
  with pytest.raises(MinecraftError):m.execute('submit',command,0,'owner','lease')
  with pytest.raises(MinecraftError):m.execute('submit',{**command,'args':{'item':'minecraft:stone','count':1}},0,'owner','lease')
  rt.host.request.assert_not_called()
 assert journal.history(binding)[0]['request']['args']==command['args']


def test_known_predispatch_rejection_is_distinct_and_can_be_attempted_after_busy_ends():
 m,rt,command=setup();binding=dict(m.binding)
 rt.host.request.side_effect=HostError('MINECRAFT_BUSY')
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  with pytest.raises(HostError):m.execute('submit',command,0,'owner','lease')
  assert journal.history(binding)[0]['dispatch']=='rejected' and m.binding
  rt.host.request.side_effect=None;rt.host.request.return_value={'task':{'taskId':'stable-id','skill':'gather','state':'queued','evidence':{}}}
  assert m.execute('submit',command,0,'owner','lease')['task']['state']=='queued'
 assert journal.history(binding)[0]['dispatch']=='observed'


def test_late_receipt_is_kept_in_original_activity_not_new_binding():
 m,rt,command=setup();binding=dict(m.binding);activity=m.activity_id
 def late(method,params):
  m.generation+=1;m.activity_id='replacement';m.tasks={}
  return {'task':{'taskId':'stable-id','skill':'gather','state':'succeeded','evidence':{'item':'minecraft:oak_log','countBefore':0,'countAfter':4}}}
 rt.host.request.side_effect=late
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  with pytest.raises(MinecraftError,match='Late'):m.execute('submit',command,0,'owner','lease')
 row=journal.history(binding,activity=activity)[0]
 assert row['state']=='succeeded' and row['evidence']['countAfter']==4
 assert journal.history(binding,activity='replacement')==[] and not m.tasks


def test_observed_duplicate_returns_original_receipt_without_second_submit():
 m,rt,command=setup()
 rt.host.request.return_value={'task':{'taskId':'stable-id','skill':'gather','state':'queued','evidence':{}}}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  m.execute('submit',command,0,'owner','lease')
  duplicate=m.execute('submit',command,0,'owner','lease')
 assert duplicate['duplicate'] and duplicate['task']['state']=='queued'
 assert rt.host.request.call_count==1


def test_stop_receipt_recovers_first_lost_reply_without_replaying():
 m,rt,command=setup();binding=dict(m.binding);activity=m.activity_id
 def response(method,params=None):
  if method=='minecraft.submit':raise HostError('MINECRAFT_UNKNOWN')
  return {'stopVerified':True,'retiredTasks':[{'taskId':'stable-id','skill':'gather','state':'succeeded','evidence':{'countBefore':0,'countAfter':4,'item':'minecraft:oak_log'}}]}
 rt.host.request.side_effect=response
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  with pytest.raises(HostError):m.execute('submit',command,0,'owner','lease')
 row=journal.history(binding,activity=activity)[0]
 assert row['state']=='succeeded' and row['dispatch']=='observed' and row['evidence']['countAfter']==4
 assert [call.args[0] for call in rt.host.request.call_args_list]==['minecraft.submit','minecraft.stop']


def test_old_queued_reply_cannot_overwrite_a_terminal_server_receipt():
 binding={'world':'w','account':'p'}
 task={'taskId':'once','skill':'wait','state':'succeeded','evidence':{'elapsedGameTicks':20}}
 journal.record(binding,'old',[task])
 journal.record(binding,'old',[{**task,'state':'queued','evidence':{}}])
 assert journal.history(binding,activity='old')[0]['state']=='succeeded'


def test_historical_activity_cannot_authorize_mutation_via_api():
 from fastapi import HTTPException
 from app.api.minecraft import TaskCommand,tasks
 command=TaskCommand(clientId='owner',leaseId='lease',generation=0,action='submit',activityId='old',taskId='once',skill='wait',args={'ticks':20})
 with patch('app.api.minecraft.invoke') as invoke:
  with pytest.raises(HTTPException) as failure:tasks(command)
 assert failure.value.status_code==422
 invoke.assert_not_called()


def test_missing_task_receipt_is_unknown_and_revokes_instead_of_empty_success():
 m,rt,command=setup();binding=dict(m.binding)
 rt.host.request.return_value={}
 with patch('app.services.minecraft.runtime',rt),patch.object(m,'gate',return_value='cfg'):
  with pytest.raises(MinecraftError) as missing:m.execute('submit',command,0,'owner','lease')
 assert missing.value.code=='MINECRAFT_RESULT_UNKNOWN' and m.binding is None
 assert journal.history(binding)[0]['state']=='unknown'
