from unittest.mock import patch
from app.core import state,db
from app.services import checkpoint,turn
from app.services.minecraft import minecraft
from app.services import minecraft_journal as journal
import json

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
 old={'kind':'minecraft','generation':7,'state':{'observedAt':1,'marker':'oldview'}}
 messages=turn.build_messages(state.load(),'',observation=old)
 messages.extend([
  {'role':'assistant','tool_calls':[{'id':'read','function':{'name':'minecraft_action','arguments':'{"action":"observe"}'}}]},
  {'role':'tool','tool_call_id':'read','content':json.dumps({'observedAt':1,'marker':'oldtoolview'})},
  {'role':'tool','tool_call_id':'effect','content':'actual_verified_action_receipt'}])
 fresh={'kind':'minecraft','generation':7,'state':{'observedAt':2,'marker':'freshview'}}
 with patch.object(minecraft,'stage_decision',return_value=fresh) as recapture:
  messages.refresh_observation()
  recapture.assert_called_once_with(7)
 assert any('freshview' in str(m.get('content','')) for m in messages)
 assert not any('oldview' in str(m.get('content','')) or 'oldtoolview' in str(m.get('content','')) for m in messages)
 assert messages[-1]['content']=='actual_verified_action_receipt'
 assert json.loads(next(m['content'] for m in messages if m.get('tool_call_id')=='read'))['superseded'] is True
