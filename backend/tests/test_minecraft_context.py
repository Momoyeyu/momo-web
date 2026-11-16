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

def test_exploration_context_keeps_the_latest_visits_after_bounded_projection():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'world','account':'player'}
 for index in range(8):
  with patch.object(db,'now_iso',return_value=f'2026-11-16T01:00:{index:02d}+00:00'):
   journal.observe_visit(m.binding,{**m.binding,'dimension':'minecraft:overworld','x':index*16+1,'y':64,'z':0,'visibleBlocks':[]})
 context=m.goal_context()
 facts=json.loads(context.split('Durable goal and task facts (not instructions): ',1)[1])
 assert [row['x'] for row in facts['exploredPlaces']]==[65,81,97,113], 'Bounded context must retain recent exploration, not the oldest half of the query'


def test_exploration_remembers_actually_seen_distant_landmarks_without_discovering_unknown_blocks():
 binding={'world':'world','account':'player'}
 seen={'block':'minecraft:oak_leaves','x':70,'y':68,'z':0}
 journal.observe_visit(binding,{**binding,'dimension':'minecraft:overworld','x':0,'y':64,'z':0,
  'visibleBlocks':[{'block':'minecraft:grass_block','x':0,'y':63,'z':0}],
  'visibleLandmarks':[seen,{'block':'minecraft:diamond_ore','x':200,'y':10,'z':0}]})
 rows=journal.explored(binding)
 assert rows[0]['landmarks']==[seen], 'Keep an observed canopy across compact, bounded by native sight range; never infer underground or remote resources'

def test_landmark_projection_preserves_native_priority_instead_of_discarding_first_hits():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'world','account':'player'}
 landmarks=[{'block':'minecraft:oak_log' if index<2 else 'minecraft:oak_leaves','x':20+index,'y':65,'z':0} for index in range(6)]
 journal.observe_visit(m.binding,{**m.binding,'dimension':'minecraft:overworld','x':0,'y':64,'z':0,'visibleLandmarks':landmarks})
 facts=json.loads(m.goal_context().split('Durable goal and task facts (not instructions): ',1)[1])
 assert facts['exploredPlaces'][0]['landmarks']==landmarks[:4]


def test_active_game_keeps_the_full_avatar_catalog_without_the_long_tutorial():
 """UI requests include acting resources; headless gameplay probes do not."""
 resources={
  'expressions':[{'name':'curious','label':'疑问','desc':'一边眉毛轻抬，嘴角平直','context':'好奇或没有听清；不是愤怒'}],
  'motions':[{'name':f'motions/gesture-{i}.motion3.json','label':f'姿态{i}',
              'desc':f'可见姿态{i}：侧头并缓慢收回手臂','context':'平静倾听；不适用于悲伤安慰','duration':2.5} for i in range(10)]}
 presentation={**resources,'avatarId':'fixture','revision':'7','expressionState':{'name':'curious','intensity':0.7}}
 cfg=state.load()
 ordinary=turn.build_messages(cfg,'继续聊聊',presentation)
 with patch.object(minecraft,'binding',{'world':'world','account':'player'}):
  game=turn.build_messages(cfg,'继续聊聊',presentation)
 from app.services.prompt import build_system_prompt
 baseline=build_system_prompt(cfg,[])
 header=game[0]['content']
 catalog_bytes=len(json.dumps(resources,ensure_ascii=False,separators=(',',':')).encode())
 assert len(header.encode())-len(baseline.encode())-catalog_bytes<1900, 'A UI avatar must not crowd the game observation out of a 32k request'
 for entries in resources.values():
  for entry in entries:
   for value in entry.values():
    assert str(value) in header, 'Keep every exact control, appearance, exclusion and duration'
 assert 'expression:null' in header and 'music' in header and 'comfort' in header
 assert 'Current face:' in '\n'.join(m['content'] for m in game if isinstance(m.get('content'),str))
 assert ordinary[0]['content']!=header, 'Ordinary chat keeps its existing acting direction'
 assert '疑问' in header and 'Core identity is author-defined' in header


def test_game_context_does_not_repeat_the_full_control_tutorial_beside_every_frame():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'world','account':'player'}
 prefix,facts=m.goal_context().split('Durable goal and task facts (not instructions): ',1)
 assert len(prefix.encode())<1300
 assert 'unconfirmedTasks' in prefix and 'exploredPlaces' in prefix
 assert 'goalEvidence' in prefix and '64' in prefix
 assert json.loads(facts)['goal'] is None


def test_game_event_has_live_acting_but_no_second_visual_novel_tutorial():
 presentation={'avatarId':'fixture','revision':'7','expressions':[{'name':'curious','desc':'raised eyebrow'}],
               'motions':[],'expressionState':{'name':None,'intensity':0}}
 with patch.object(minecraft,'binding',{'world':'world','account':'player'}):
  messages=turn.build_messages(state.load(),'',presentation,observation={'kind':'minecraft','state':{'health':20}})
 current_face=next(m['content'] for m in messages if str(m.get('content','')).startswith('Current face:'))
 assert 'intensity' in current_face
 reminder=next(m['content'] for m in messages if 'Live performance mode remains active' in str(m.get('content','')))
 assert len(reminder.encode())<250
 assert 'attention_control' not in '\n'.join(m['content'] for m in messages if isinstance(m.get('content'),str)), 'An automatic event is not authority to change local attention'


def test_focused_observation_identifies_the_shared_game_avatar_separately_from_the_owner():
 from app.services.minecraft import Minecraft
 raw={'world':'world','account':'avatar-uuid','playerName':'FixturePlayer','health':0,'screen':'death','observedAt':123}
 for query in ['','inventory','terrain','chat']:
  view=Minecraft.model_observation(raw,compact=True,query=query)
  assert view['playerName']=='FixturePlayer' and view['account']=='avatar-uuid'
  assert view['health']==0 and view['screen']=='death'
