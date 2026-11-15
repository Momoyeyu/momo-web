import pytest
from app.services import minecraft_journal as journal
from app.core import db

def test_goal_survives_chat_context_reset_and_is_scoped_to_world_and_character():
 binding={'world':'a','account':'player'}
 goal={'title':'做一个安静的小花园','reason':'喜欢花和路边的景色','source':'aesthetic','expected':'有一圈花','status':'active','constraints':'不用作弊'}
 journal.set_goal(binding,goal)
 with db.tx() as c:c.execute("UPDATE sessions SET summary=?,generation=generation+1 WHERE id='live'", ('compact context',))
 assert journal.goal(binding)==goal
 assert journal.goal({'world':'b','account':'player'}) is None
 assert journal.goal({'world':'a','account':'other'}) is None

def test_receipts_are_idempotent_and_acceptance_is_not_completion():
 b={'world':'w','account':'p'};task={'taskId':'t','state':'queued','skill':'craft','evidence':{}}
 assert len(journal.record(b,1,[task]))==1
 assert journal.record(b,1,[task])==[]
 with pytest.raises(ValueError,match='Unverified'):journal.record(b,1,[{**task,'state':'succeeded'}])
 journal.record(b,1,[{**task,'state':'succeeded','evidence':{'item':'minecraft:stick','countAfter':4}}])
 assert journal.recent(b)[0]['state']=='succeeded'

def test_restart_uses_new_activity_identity_even_if_ui_generation_and_task_id_repeat():
 from app.services.minecraft import Minecraft
 binding={'world':'w','account':'p'}
 a,b=Minecraft(),Minecraft();a.binding=b.binding=binding
 first={'taskId':'walk','state':'succeeded','skill':'navigate','evidence':{'x':1}}
 a.record_tasks([first],a.generation)
 b.record_tasks([{**first,'evidence':{'x':2}}],b.generation)
 assert len(journal.recent(binding))==2

def test_rebind_marks_old_unconfirmed_tasks_unknown_without_replay_or_false_success():
 b={'world':'w','account':'p'}
 journal.record(b,'old',[{'taskId':'dig','state':'running','evidence':{'blocksBroken':1}},
                         {'taskId':'walk','state':'succeeded','evidence':{'x':1}}])
 journal.reconcile(b)
 tasks={t['taskId']:t for t in journal.recent(b)}
 assert tasks['dig']['state']=='unknown'
 assert tasks['dig']['evidence']=={'blocksBroken':1}
 assert tasks['walk']['state']=='succeeded'

def test_old_integer_generation_table_migrates_without_losing_facts():
 with db.tx() as c:
  c.execute('CREATE TABLE minecraft_tasks(scope TEXT NOT NULL,generation INTEGER NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,generation,task_id))')
 journal.record({'world':'w'},1,[{'taskId':'old','state':'succeeded','evidence':{'x':1}}])
 journal.record({'world':'w'},'game-new',[{'taskId':'old','state':'succeeded','evidence':{'x':2}}])
 assert len(journal.recent({'world':'w'}))==2

def test_exploration_remembers_only_observed_visits_and_isolated_dimensions():
 b={'world':'w','account':'p'}
 obs={**b,'dimension':'minecraft:overworld','x':-1.5,'y':64,'z':2,
      'visibleBlocks':[{'block':'minecraft:crafting_table','x':1,'y':64,'z':2},
                       {'block':'minecraft:diamond_ore','x':100,'y':1,'z':2}]}
 journal.observe_visit(b,obs)
 places=journal.explored(b)
 assert len(places)==1 and places[0]['dimension']=='minecraft:overworld'
 assert places[0]['landmarks']==[{'block':'minecraft:crafting_table','x':1,'y':64,'z':2}]
 journal.observe_visit(b,{**obs,'dimension':'minecraft:the_nether'})
 assert len(journal.explored(b))==2
 assert journal.explored({'world':'other','account':'p'})==[]
 journal.observe_visit(b,{**obs,'world':'spoofed','x':999})
 assert len(journal.explored(b))==2

def test_stop_snapshot_does_not_drop_newest_facts_after_256_tasks():
 b={'world':'long-session','account':'p'}
 tasks=[{'taskId':f't{i}','state':'succeeded','evidence':{'x':i}} for i in range(257)]
 journal.record(b,'game-one',tasks)
 assert journal.recent(b)[-1]['taskId']=='t256'

def intent(title='歇脚点',**extra):
 return {'title':title,'reason':'喜欢安静','source':'aesthetic','expected':title+'可以使用','status':'active',**extra}

def gain(task_id='wood',state='succeeded',before=0,after=4):
 return {'taskId':task_id,'skill':'gather','state':state,'evidence':{'item':'minecraft:oak_log','countBefore':before,'countAfter':after}}

def test_goal_progress_survives_compact_restart_and_duplicate_receipts_without_authority():
 b={'world':'home','account':'p'};goal=intent();journal.set_goal(b,goal)
 journal.bind_task(b,'activity','wood')
 journal.record(b,'activity',[{**gain(),'state':'queued'}]);assert journal.progress(b)==[]
 journal.record(b,'activity',[gain()]);journal.record(b,'activity',[gain()])
 first=journal.progress(b);assert len(first)==1 and first[0]['gains']==[{'item':'minecraft:oak_log','count':4}]
 journal.set_goal(b,{**goal,'progress':'已有木材'})
 with db.tx() as c:c.execute("UPDATE sessions SET summary=?,generation=generation+1 WHERE id='live'",('compacted',))
 assert journal.progress(b)==first and journal.goal(b)['progress']=='已有木材'
 from app.services.minecraft import Minecraft
 restarted=Minecraft();restarted.binding=b
 assert restarted.goal_evidence()==first and restarted.permissions==set() and not restarted.autonomous
 assert journal.progress({**b,'world':'other'})==[] and journal.progress({**b,'account':'other'})==[]

def test_late_old_goal_receipt_stays_a_fact_but_cannot_become_new_goal_progress():
 b={'world':'home','account':'p'};journal.set_goal(b,intent('花园'))
 old=journal.bind_task(b,'activity','same')
 journal.set_goal(b,intent('小屋'))
 assert journal.bind_task(b,'activity','same')==old,'Reconciliation must never reassign an already dispatched ID'
 journal.record(b,'activity',[gain('same')]);assert journal.progress(b)==[]
 assert journal.recent(b)[-1]['state']=='succeeded'
 assert journal.bind_task(b,'new-activity','same')!=old
 journal.record(b,'new-activity',[gain('same')]);assert len(journal.progress(b))==1

def test_restarting_completed_intention_does_not_reuse_old_achievement_or_adopt_legacy_receipts():
 b={'world':'home','account':'p'};goal=intent()
 journal.set_goal(b,goal);journal.bind_task(b,'a','wood');journal.record(b,'a',[gain()])
 journal.set_goal(b,{**goal,'status':'completed'});assert journal.progress(b)
 journal.set_goal(b,goal);assert journal.progress(b)==[]
 journal.record(b,'unmapped',[gain('legacy')]);assert journal.progress(b)==[]

def test_partial_goal_progress_requires_real_changes_and_preserves_original_proof():
 b={'world':'home','account':'p'};journal.set_goal(b,intent())
 for name in ['partial','zero','pending','building']:journal.bind_task(b,'a',name)
 journal.record(b,'a',[gain('partial','failed',2,5),gain('zero','failed',2,2),gain('pending','queued',0,8)])
 raw={'taskId':'building','skill':'build','state':'failed','reason':'build_blocked','evidence':{
  'confirmedCells':[{'x':1,'y':64,'z':2,'block':'Block{minecraft:oak_planks}','serverBlockSeq':9},
                    {'x':2,'y':64,'z':2,'block':'Block{minecraft:oak_planks}','observedExisting':True}],
  'remainingCells':[{'x':3,'y':64,'z':2,'block':'minecraft:oak_planks'}]}}
 journal.record(b,'a',[raw]);facts=journal.progress(b)
 assert {f['taskId'] for f in facts}=={'partial','building'}
 assert next(f for f in facts if f['taskId']=='partial')['gains'][0]['count']==3
 built=next(f for f in facts if f['taskId']=='building');assert built['placed']==[{'block':'minecraft:oak_planks','count':1}] and built['partial'] is True
 assert next(t for t in journal.recent(b) if t['taskId']=='building')==raw


def test_verified_progress_keeps_original_task_dimension_and_never_invents_one_for_legacy_facts():
 b={'world':'home','account':'p'};journal.set_goal(b,intent())
 journal.bind_task(b,'a','old-scene');journal.bind_task(b,'a','legacy')
 old={**gain('old-scene'),'dimension':'minecraft:the_nether'}
 journal.record(b,'a',[old,gain('legacy')])
 facts={row['taskId']:row for row in journal.progress(b)}
 assert facts['old-scene']['dimension']=='minecraft:the_nether'
 from app.services.minecraft import Minecraft
 assert Minecraft._task_context(old)['dimension']=='minecraft:the_nether'
 assert 'dimension' not in facts['legacy']
 assert journal.recent(b)[0]['dimension']=='minecraft:the_nether'
