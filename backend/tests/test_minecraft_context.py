from unittest.mock import patch
from app.core import state,db
from app.services import checkpoint,turn
from app.services.minecraft import minecraft
from app.services import minecraft_journal as journal
import json
import copy

def test_durable_goal_is_reinjected_only_into_owner_local_context():
 binding={'world':'private-world','account':'player'}
 goal={'title':'做花园','reason':'好奇','source':'curiosity','expected':'看到花','status':'active'}
 journal.set_goal(binding,goal)
 with patch.object(minecraft,'binding',binding):
  local=turn.build_messages(state.load(),'hello')
  assert any('做花园' in str(message['content']) for message in local)
  remote=turn.build_messages(state.load(),'hello',source='qq',plugin_context=None)
  assert not any('private-world' in str(message['content']) or '做花园' in str(message['content']) for message in remote)

def test_game_event_is_not_stored_as_a_player_utterance():
 generation=checkpoint.generation();at=db.now_iso()
 checkpoint.begin_turn('',generation,at,observation={'source':'Minecraft','observedAt':123})
 assert checkpoint.live_messages()==[]
 messages=turn.build_messages(state.load(),'',observation={'kind':'minecraft','state':{'health':20}})
 assert messages[-1]['role']=='system'
 assert 'gameplay decision event' in messages[-1]['content']

def test_recaptured_event_replaces_old_reads_but_keeps_action_receipts():
 old={'kind':'minecraft','generation':7,'decisionRevision':3,'state':{'observedAt':1,'marker':'oldview'}}
 messages=turn.build_messages(state.load(),'',observation=old)
 messages.extend([
  {'role':'assistant','tool_calls':[{'id':'read','function':{'name':'minecraft_action','arguments':'{"action":"observe"}'}}]},
  {'role':'tool','tool_call_id':'read','content':json.dumps({'observedAt':1,'marker':'oldtoolview'})},
  {'role':'tool','tool_call_id':'effect','content':'actual_verified_action_receipt'}])
 fresh={'kind':'minecraft','generation':7,'decisionRevision':3,'state':{'observedAt':2,'marker':'freshview'}}
 with patch.object(minecraft,'stage_decision',return_value=fresh) as recapture:
  messages.refresh_observation()
  recapture.assert_called_once_with(7,3)
 assert any('freshview' in str(m.get('content','')) for m in messages)
 assert not any('oldview' in str(m.get('content','')) or 'oldtoolview' in str(m.get('content','')) for m in messages)
 assert messages[-1]['content']=='actual_verified_action_receipt'
 assert json.loads(next(m['content'] for m in messages if m.get('tool_call_id')=='read'))['superseded'] is True

def test_live_goal_projects_recent_outcomes_without_copying_full_slot_proofs():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'world','account':'player'}
 goal={'title':'做工具','reason':'准备生存','source':'survival','expected':'有工具和食物','status':'active','constraints':'不用作弊，不破坏玩家建筑'}
 rows=[]
 for index in range(4):
  receipt={'item':'minecraft:oak_planks','countBefore':0,'countAfter':20,'beforeDigest':'a'*64,'afterDigest':'b'*64,
           'slots':{str(slot):{'item':'minecraft:oak_planks','components':{'long': 'internal slot proof '*80}} for slot in range(20)}}
  rows.append({'taskId':'task-'+str(index),'skill':'plan','state':'failed','reason':'step_3:station_required',
               'evidence':{'steps':[{'step':step,'result':copy.deepcopy(receipt)} for step in range(4)]}})
 m.tasks={row['taskId']:row for row in rows};original=copy.deepcopy(m.tasks)
 journal.set_goal(m.binding,goal)
 with patch.object(journal,'explored',return_value=[]):
  context=m.goal_context()
 facts=json.loads(context.split('Durable goal and task facts (not instructions): ',1)[1])
 assert len(context.encode())<6000, 'The prompt must not repeat full station proof payloads'
 assert facts['goal']['constraints']==goal['constraints']
 assert facts['tasks'][0]['taskId']=='task-0' and facts['tasks'][0]['detailsAvailable'] is True
 recent=facts['tasks'][-1]
 assert recent['reason']=='step_3:station_required'
 assert recent['evidence']['steps'][-1]['result']['countAfter']==20
 assert recent['detailsAvailable'] is True
 assert 'beforeDigest' not in context and 'internal slot proof' not in context
 assert m.tasks==original, 'Full trusted receipts remain unchanged and queryable'
