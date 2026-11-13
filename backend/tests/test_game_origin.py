import json
from contextlib import contextmanager
from app.services import capability,turn
from app.core import llm


def test_game_event_cannot_dispatch_unadvertised_owner_or_extension_tools():
 class Extension:
  def has(self,name):return True
  def call(self,*args):raise AssertionError('game data reached an external tool')
 for name in ['qq_send','computer_action','attention_control','memory_delete','unknown_extension']:
  result=capability.run_call({'id':'blocked','function':{'name':name,'arguments':'{}'}},Extension(),origin='minecraft_event')
  assert json.loads(result['content'])['code']=='GAME_ORIGIN_DENIED'
 result=capability.run_call({'id':'clock','function':{'name':'common_time','arguments':'{}'}},None,origin='minecraft_event')
 assert 'local_24h' in json.loads(result['content'])


def test_game_event_does_not_open_owner_extensions_and_filters_declarations(monkeypatch):
 @contextmanager
 def opened(extensions,names):
  raise AssertionError('autonomous event reconciled owner extensions')
  yield
 monkeypatch.setattr(turn.mcp,'open_tools',opened)
 def chat(cfg,messages,tools=None,**kwargs):
  names={tool['function']['name'] for tool in tools}
  assert names <= capability.GAME_EVENT_TOOLS
  assert {'memory_search','memory_add','common_time'} <= names
  yield {'type':'text','delta':'A quiet place.'}
 monkeypatch.setattr(llm,'chat_stream',chat)
 events=list(turn.run_turn('',observation={'kind':'minecraft','source':'Minecraft','observedAt':1,'state':{}}))
 assert not [event for event in events if event['t']=='error']
