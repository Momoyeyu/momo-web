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
