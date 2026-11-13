from unittest.mock import patch
from app.core import state,db
from app.services import checkpoint,turn
from app.services.minecraft import minecraft
from app.services import minecraft_journal as journal

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
