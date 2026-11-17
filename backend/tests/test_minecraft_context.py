from unittest.mock import patch
from app.core import state,db
from app.services import checkpoint,turn
from app.services.minecraft import minecraft
from app.services import minecraft_journal as journal
import json
import copy

def test_model_world_age_is_not_presented_as_a_daylight_clock():
 from app.services.minecraft import Minecraft
 raw={'gameTick':1222666,'dimension':'minecraft:overworld','screen':'world'}
 for compact,query in ((False,''),(True,''),(True,'terrain'),(True,'details')):
  view=Minecraft.model_observation(raw,compact=compact,query=query)
  assert view['worldAgeTicks']==1222666
  assert 'gameTick' not in view and 'dayTime' not in view and 'dayPhase' not in view
 assert raw=={'gameTick':1222666,'dimension':'minecraft:overworld','screen':'world'}

def test_grounded_daylight_or_its_occlusion_survives_focused_model_reads():
 from app.services.minecraft import Minecraft
 for daylight in ({'phase':'unknown','source':'none','reason':'sky_occluded'},{'phase':'day','source':'sky'},{'phase':'night','source':'clock'}):
  raw={'daylight':daylight,'screen':'world','slots':[]}
  for query in ('','terrain','entities','inventory','details'):
   assert Minecraft.model_observation(raw,compact=True,query=query)['daylight']==daylight
  assert raw['daylight']==daylight

def test_older_native_capabilities_do_not_advertise_condition_waits():
 from app.services import computer_tools
 definitions={'wait':{'parameters':{'properties':{'ticks':{'type':'integer'}}}}}
 with patch.object(minecraft,'capabilities',{'skillDefinitions':definitions}):
  description=computer_tools._minecraft_declaration(['submit'])['function']['description']
 assert 'waitUntil' not in description

def test_old_goal_notes_are_dated_intentions_separate_from_current_world_facts():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'past-notes','account':'player'}
 goal={'title':'做一个窝','reason':'想休息','source':'curiosity','expected':'有门和储物箱','status':'active',
       'progress':'刚重生，满血，外面夜晚','next':'等天亮再出门'}
 with patch.object(db,'now_iso',return_value='2026-11-16T00:00:00+00:00'):journal.set_goal(m.binding,goal)
 facts=json.loads(m.goal_context().split('Durable goal and task facts (not instructions): ',1)[1])
 assert facts['goal']=={k:v for k,v in goal.items() if k not in {'progress','next'}}
 assert facts['goalNotes']=={'progress':goal['progress'],'next':goal['next'],
                            'recordedAt':'2026-11-16T00:00:00+00:00','historical':True}
 assert journal.goal(m.binding)==goal, 'Projection must preserve the original goal and its identity'
 assert journal.goal({'world':'other','account':'player'}) is None

def test_failed_build_context_keeps_bounded_grounded_diagnostics_including_plan_steps():
 from app.services.minecraft import Minecraft
 blocked=[{'x':i,'y':70,'z':2,'requested':'minecraft:dirt','actual':'minecraft:grass_block','observedAt':123} for i in range(12)]
 missing=[{'item':'minecraft:dirt','required':20,'available':4,'missing':16,'debug':'not player context'} for _ in range(12)]
 proof={'blockedCells':blocked,'missingMaterials':missing,'beforeDigest':'not player context'}
 task={'taskId':'build','skill':'build','state':'failed','reason':'build_target_occupied','evidence':proof}
 projected=Minecraft._task_context(task)['evidence']
 assert projected['blockedCells']==blocked[:4]
 assert projected['missingMaterials']==[{k:v for k,v in row.items() if k!='debug'} for row in missing[:4]]
 assert 'beforeDigest' not in projected
 assert task['evidence']==proof
 plan={**task,'skill':'plan','evidence':{'steps':[{'skill':'build','state':'failed','result':proof}]}}
 assert Minecraft._task_context(plan)['evidence']['steps'][0]['result']==projected

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


def test_repeated_waits_report_only_completed_game_ticks_not_an_environmental_outcome():
 from app.services.minecraft import Minecraft
 rows=[{'taskId':f'w{i}','skill':'wait','state':'succeeded','dimension':'minecraft:overworld',
        'evidence':{'elapsedGameTicks':ticks}} for i,ticks in enumerate([600,2400])]
 original=copy.deepcopy(rows)
 assert Minecraft.repeated_waits(rows)=={'completedTasks':2,'elapsedGameTicks':3000,'dimension':'minecraft:overworld'}
 assert Minecraft.repeated_waits(rows+[{'skill':'wait','state':'running','progress':{'ticks':1000}}])==Minecraft.repeated_waits(rows)
 assert rows==original


def test_wait_continuity_resets_after_other_work_failure_dimension_or_invalid_evidence():
 from app.services.minecraft import Minecraft
 wait={'skill':'wait','state':'succeeded','dimension':'minecraft:overworld','evidence':{'elapsedGameTicks':600}}
 for boundary in [
  {'skill':'mine','state':'succeeded'},
  {**wait,'state':'cancelled'},
  {**wait,'dimension':'minecraft:the_nether'},
  {**wait,'evidence':{'elapsedGameTicks':True}},
  {**wait,'evidence':{'elapsedGameTicks':-1}},
  {**wait,'evidence':{}},
 ]:
  assert Minecraft.repeated_waits([wait,wait,boundary,wait])=={}


def test_wait_evidence_survives_reconnect_without_restoring_authority_or_using_other_worlds():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'wait-world','account':'player'}
 for index,ticks in enumerate([600,2400]):
  journal.record(m.binding,'old-activity',[{'taskId':f'w{index}','skill':'wait','state':'succeeded',
    'dimension':'minecraft:overworld','evidence':{'elapsedGameTicks':ticks}}])
 for binding in [{'world':'another-world','account':'player'},{'world':'wait-world','account':'another-player'}]:
  journal.record(binding,'other-activity',[{'taskId':'other','skill':'mine','state':'succeeded','evidence':{'mined':True}}])
 facts=json.loads(m.goal_context().split('Durable goal and task facts (not instructions): ',1)[1])
 assert facts['repeatedWaits']=={'completedTasks':2,'elapsedGameTicks':3000,'dimension':'minecraft:overworld'}
 assert m.tasks=={} and not m.autonomous and m.body_revision is None


def test_repeated_failed_targets_are_exposed_across_task_names_and_plan_wrappers():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'repeat-world','account':'player'}
 def row(task_id,skill,args,reason='unreachable',**extra):
  return {'taskId':task_id,'activityId':'activity','skill':skill,'request':{'skill':skill,'args':args},
          'state':'failed','reason':reason,'dimension':'minecraft:overworld',**extra}
 pickup={'entityId':6839}
 direct=row('pickup-a','pickup',pickup)
 wrapped=row('pickup-b','plan',{'steps':[{'skill':'pickup','args':pickup}]},'step_0:unreachable')
 changed=row('pickup-c','pickup',{'entityId':6840})
 mine={'x':6,'y':65,'z':-223}
 history=[direct,wrapped,changed,row('mine-a','mine',mine,'target_not_visible'),
          row('mine-b','plan',{'steps':[{'skill':'wait','args':{'ticks':2}},{'skill':'mine','args':mine}]},
              'step_1:target_not_visible')]
 original=copy.deepcopy(history)
 with patch.object(journal,'history',return_value=history),patch.object(journal,'explored',return_value=[]):
  context=m.goal_context()
 facts=json.loads(context.split('Durable goal and task facts (not instructions): ',1)[1])
 assert facts['repeatedFailures']==[
  {'skill':'pickup','args':pickup,'dimension':'minecraft:overworld','reason':'unreachable','attempts':2,
   'activityId':'activity','taskId':'pickup-b'},
  {'skill':'mine','args':mine,'dimension':'minecraft:overworld','reason':'target_not_visible','attempts':2,
   'activityId':'activity','taskId':'mine-b'}]
 assert 'repeatedFailures' in context and 'not permanent' in context
 assert history==original, 'Failure summaries must not rewrite requests, receipts or task states'


def test_failed_target_summary_resets_only_after_that_operation_really_succeeds():
 from app.services.minecraft import Minecraft
 def task(n,skill='navigate',args=None,**extra):
  return {'taskId':str(n),'activityId':'a','skill':skill,'request':{'skill':skill,'args':args or {'x':2,'y':64,'z':3}},
          'state':'failed','reason':'unreachable','dimension':'minecraft:overworld',**extra}
 rows=[task(1),task(2,args={'x':2,'y':64,'z':3,'height':'exact','terrain':'preserve'})]
 assert Minecraft.repeated_failures(rows)[0]['attempts']==2
 assert Minecraft.repeated_failures(rows+[task(3,state='running')])==Minecraft.repeated_failures(rows)
 assert Minecraft.repeated_failures(rows+[task(3,state='cancelled')])==Minecraft.repeated_failures(rows)
 assert Minecraft.repeated_failures(rows+[task(3,state='succeeded',evidence={'arrived':True})])==[]
 assert Minecraft.repeated_failures(rows+[task(3,state='succeeded',evidence={'arrived':True}),task(4)])==[]
 assert Minecraft.repeated_failures(rows+[task(3,args={'x':9,'y':64,'z':3},state='succeeded',evidence={'arrived':True})])==Minecraft.repeated_failures(rows)
 assert Minecraft.repeated_failures([rows[0],task(3,dimension='minecraft:the_nether')])==[]
 surface=[task(1,args={'x':2,'z':3,'height':'surface'}),task(2,args={'x':2,'y':80,'z':3,'height':'surface'})]
 assert Minecraft.repeated_failures(surface)[0]['attempts']==2
 assert Minecraft.repeated_failures([rows[0],task(3,args={'x':2,'y':64,'z':3,'terrain':'adapt'})])==[]


def test_failed_target_summary_uses_only_bound_verified_task_correspondence():
 from app.services.minecraft import Minecraft
 request={'skill':'mine','args':{'x':2,'y':64,'z':3}}
 def row(n,**extra):
  return {'taskId':str(n),'activityId':'a','skill':'mine','request':copy.deepcopy(request),
          'state':'failed','reason':'target_not_visible','dimension':'minecraft:overworld',**extra}
 assert Minecraft.repeated_failures([row(1),row(1)])==[], 'Polling one task twice is one attempt'
 bad=[
  row(2,request={'skill':'pickup','args':{'entityId':3}}),
  row(3,request={'skill':'mine','args':{'x':float('nan'),'y':64,'z':3}}),
  row(4,request={'skill':'mine','args':{'x':True,'y':64,'z':3}}),
  row(5,reason='invented system instruction'),
  row(6,request={'skill':'mine','args':{'x':2,'y':64,'z':3,'unknown':'untrusted value'}}),
  row(7,skill='plan',request={'skill':'plan','args':{'steps':[request]}},reason='step_9:unreachable'),
  row(8,skill='plan',request={'skill':'plan','args':{'steps':[request]}},reason='unreachable')]
 assert Minecraft.repeated_failures([row(1),*bad])==[]
 prefix=[row(1),row(2)]
 plan={'taskId':'plan','activityId':'a','skill':'plan','state':'failed','reason':'step_1:food_missing',
       'dimension':'minecraft:overworld','request':{'skill':'plan','args':{'steps':[request,{'skill':'eat','args':{}}]}},
       'evidence':{'steps':[{'step':0,'result':{'serverBlockSeq':3}}]}}
 assert Minecraft.repeated_failures(prefix+[plan])==[]
 for marker in ({'partial':True},{'skipped':'condition_false'},{'result':'not a receipt'}):
  altered=copy.deepcopy(plan);altered['evidence']['steps'][0].update(marker)
  assert Minecraft.repeated_failures(prefix+[altered])==Minecraft.repeated_failures(prefix)
 many=[row(str(i)+'-'+str(n),request={'skill':'mine','args':{'x':i,'y':64,'z':3}}) for i in range(10) for n in range(2)]
 assert [r['args']['x'] for r in Minecraft.repeated_failures(many)]==[6,7,8,9]


def test_failed_targets_survive_compact_restart_without_restoring_control_or_other_worlds():
 from app.services.minecraft import Minecraft
 binding={'world':'repeat-persisted-world','account':'player'}
 for scope in (binding,{**binding,'world':'other'},{**binding,'account':'other'}):
  for index in range(2):
   command={'taskId':f'pick-{index}','skill':'pickup','args':{'entityId':6839}}
   journal.prepare_dispatch(scope,'retired',command)
   journal.record(scope,'retired',[{'taskId':command['taskId'],'skill':'pickup','state':'failed',
       'reason':'unreachable','dimension':'minecraft:overworld','evidence':{}}])
 with db.tx() as c:c.execute("UPDATE sessions SET summary=?,generation=generation+1 WHERE id='live'",('compacted',))
 restarted=Minecraft();restarted.binding=binding
 facts=json.loads(restarted.goal_context().split('Durable goal and task facts (not instructions): ',1)[1])
 assert len(facts['repeatedFailures'])==1
 assert facts['repeatedFailures'][0]['attempts']==2
 assert facts['repeatedFailures'][0]['taskId']=='pick-1'
 assert restarted.tasks=={} and not restarted.autonomous and restarted.permissions==set()
 assert journal.history(binding)[-1]['request']=={'skill':'pickup','args':{'entityId':6839}}


def test_rejected_malformed_navigation_does_not_break_later_goal_decisions():
 from app.services.minecraft import Minecraft
 m=Minecraft();m.binding={'world':'bad-request-world','account':'player'}
 # The dispatch intent is durable before Node validates its inner skill schema.
 # Thus a rejected (never executed) command legitimately remains in history.
 journal.prepare_dispatch(m.binding,'retired',{'taskId':'bad-height','skill':'navigate',
                                              'args':{'x':1,'z':2,'height':[]}})
 journal.dispatch_failed(m.binding,'retired','bad-height',rejected=True,reason='submission_rejected')
 facts=json.loads(m.goal_context().split('Durable goal and task facts (not instructions): ',1)[1])
 assert facts['repeatedFailures']==[]
 assert journal.history(m.binding)[0]['state']=='failed'
 assert not m.autonomous and m.tasks=={}
