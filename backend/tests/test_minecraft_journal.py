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
