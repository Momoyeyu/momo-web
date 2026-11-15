import json
from contextlib import contextmanager
from app.services import capability,turn
from app.core import llm
from app.services import computer_tools,vision
from app.services.minecraft import MinecraftError
import pytest

@pytest.mark.parametrize('edge',['before_inference','during_maintenance','provider_text','provider_tools','between_tools'])
def test_revoked_automatic_decision_cannot_infer_publish_or_dispatch_more_tools(monkeypatch,edge):
 valid=edge!='before_inference';models=[];effects=[];checks=[]
 def guard(*,refresh=False):
  checks.append(refresh)
  if not valid:raise MinecraftError('Game decision revoked',code='MINECRAFT_DECISION_REVOKED')
 def maintain(*args,**kwargs):
  nonlocal valid
  if edge=='during_maintenance':valid=False
 def provider(*args,**kwargs):
  nonlocal valid
  models.append(1)
  if edge in {'provider_text','provider_tools'}:valid=False
  if edge=='provider_text':yield {'type':'text','delta':'This never happened.'}
  else:yield {'type':'tool_calls','calls':[{'id':name,'function':{'name':'memory_add','arguments':'{}'}} for name in ['first','late']]}
 def effect(call,ext,**kwargs):
  nonlocal valid
  effects.append(call['id']);valid=False
  return {'role':'tool','tool_call_id':call['id'],'content':'{}'}
 monkeypatch.setattr(turn.compress,'guard_request',maintain)
 monkeypatch.setattr(llm,'chat_stream',provider)
 monkeypatch.setattr(turn,'run_call',effect)
 events=list(turn.run_turn('',observation={'kind':'minecraft','source':'Minecraft','observedAt':1,'state':{}},validate_event=guard))
 assert models==([] if edge in {'before_inference','during_maintenance'} else [1])
 assert effects==(['first'] if edge=='between_tools' else [])
 assert not [event for event in events if event['t']=='sentence']
 assert True in checks, 'expensive inference and effects need a fresh local body check'

@pytest.mark.parametrize('automatic',[True,False])
def test_api_rechecks_game_permit_before_publication_but_keeps_owner_chat_available(monkeypatch,automatic):
 import asyncio,time
 from app.api import chat as api
 from app.core import db
 from app.services.coordinator import Coordinator
 from app.services.minecraft import minecraft
 core=Coordinator();core.started=True;core.mode='meeting'
 core.owner={'clientId':'owner','leaseId':'lease','expiresAt':time.monotonic()+15}
 monkeypatch.setattr(api,'runtime',core)
 model_started=False;checks=[]
 def validate(generation,revision,*,refresh=False):
  assert (generation,revision)==(17,3)
  checks.append(refresh)
  if refresh and model_started:raise MinecraftError('Game decision revoked',code='MINECRAFT_DECISION_REVOKED')
 def provider(*args,**kwargs):
  nonlocal model_started
  model_started=True
  yield {'type':'text','delta':'A quiet place.'}
 monkeypatch.setattr(llm,'chat_stream',provider)
 monkeypatch.setattr(minecraft,'claim_decision',lambda *args:{'kind':'minecraft','generation':17,'decisionRevision':3})
 monkeypatch.setattr(minecraft,'stage_decision',lambda generation,revision:{'kind':'minecraft','source':'Minecraft','generation':generation,'decisionRevision':revision,'observedAt':1,'state':{}})
 monkeypatch.setattr(minecraft,'validate_decision',validate)
 if automatic:response=api.minecraft_decision(api.ScreenReactionIn(clientId='owner',leaseId='lease',generation=17))
 else:response=api.chat(api.ChatIn(clientId='owner',leaseId='lease',text='hello'))
 async def consume():
  frames=[]
  async for frame in response.body_iterator:frames.append(frame.decode() if isinstance(frame,bytes) else frame)
  return [json.loads(row[6:]) for row in ''.join(frames).splitlines() if row.startswith('data: ')]
 events=asyncio.run(consume())
 assert model_started
 if automatic:
  assert True in checks and not [event for event in events if event['t'] in {'sentence','error'}]
  assert core.presentation is None
  assert not db.query("SELECT 1 FROM messages WHERE role='assistant' AND visible=1")
 else:
  assert checks==[] and [event['text'] for event in events if event['t']=='sentence']==['A quiet place.']

def test_api_marks_silent_revocation_after_a_streamed_sentence_as_suppressed(monkeypatch):
 import asyncio,time
 from app.api import chat as api
 from app.services.coordinator import Coordinator
 from app.services.minecraft import minecraft
 core=Coordinator();core.started=True;core.mode='meeting'
 core.owner={'clientId':'owner','leaseId':'lease','expiresAt':time.monotonic()+15}
 monkeypatch.setattr(api,'runtime',core)
 valid=True
 def validate(*args,**kwargs):
  if not valid:raise MinecraftError('Game decision revoked',code='MINECRAFT_DECISION_REVOKED')
 def streamed(*args,**kwargs):
  nonlocal valid
  yield {'t':'sentence','no':0,'text':'An earlier line.','cues':[],'generation':0}
  valid=False  # A cancelled inner turn may return silently, without another event.
 monkeypatch.setattr(minecraft,'claim_decision',lambda *args:{'kind':'minecraft','generation':17,'decisionRevision':3})
 monkeypatch.setattr(minecraft,'stage_decision',lambda *args:{'kind':'minecraft','source':'Minecraft','observedAt':1,'state':{}})
 monkeypatch.setattr(minecraft,'validate_decision',validate)
 monkeypatch.setattr(turn,'run_turn',streamed)
 response=api.minecraft_decision(api.ScreenReactionIn(clientId='owner',leaseId='lease',generation=17))
 async def consume():
  frames=[]
  async for frame in response.body_iterator:frames.append(frame.decode() if isinstance(frame,bytes) else frame)
  return [json.loads(row[6:]) for row in ''.join(frames).splitlines() if row.startswith('data: ')]
 events=asyncio.run(consume())
 assert [event['text'] for event in events if event['t']=='sentence']==['An earlier line.']
 assert events[-1]=={'t':'done','suppressed':True}
 assert core.presentation is None


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


def test_game_event_stops_its_turn_after_releasing_its_binding(monkeypatch):
 calls=[]
 def chat(*args,**kwargs):
  assert not calls, 'stopped activity must not start another model request'
  yield {'type':'tool_calls','calls':[
   {'id':'stop','function':{'name':'minecraft_action','arguments':'{"action":"stop"}'}},
   {'id':'late','function':{'name':'minecraft_goal','arguments':'{}'}}]}
 def execute(call,ext,**kwargs):
  calls.append(call['id'])
  return {'role':'tool','tool_call_id':call['id'],'content':json.dumps({'stopped':True,'active':False})}
 monkeypatch.setattr(llm,'chat_stream',chat)
 monkeypatch.setattr(turn,'run_call',execute)
 events=list(turn.run_turn('',observation={'kind':'minecraft','source':'Minecraft','observedAt':1,'state':{}}))
 assert calls==['stop']
 assert not [event for event in events if event['t']=='error']

def test_automatic_game_decision_can_be_silent_without_twelve_empty_model_calls(monkeypatch):
 calls=[]
 def chat(*args,**kwargs):
  calls.append(1)
  yield from ()
 monkeypatch.setattr(llm,'chat_stream',chat)
 events=list(turn.run_turn('',observation={'kind':'minecraft','source':'Minecraft','observedAt':1,'state':{}}))
 assert len(calls)==1 and not [event for event in events if event['t']=='error']

def test_capacity_yields_only_automatic_game_decisions_without_hiding_provider_errors(monkeypatch):
 def full(*args,**kwargs):raise llm.LlmError('Context capacity reached; please retry after maintenance')
 monkeypatch.setattr(turn.compress,'guard_request',full)
 event={'kind':'minecraft','source':'Minecraft','observedAt':1,'state':{}}
 assert not [e for e in turn.run_turn('',observation=event) if e['t']=='error']
 def bad_provider(*args,**kwargs):raise llm.LlmError('Provider authentication failed')
 monkeypatch.setattr(turn.compress,'guard_request',bad_provider)
 assert [e for e in turn.run_turn('',observation=event) if e['t']=='error']


def test_game_frame_capacity_discards_then_maintains_then_recaptures(monkeypatch):
 order=[]
 class Messages(list):
  def refresh_observation(self):order.append('fresh')
 def fit(*args):
  if not order:raise vision.VisionError('computer.budget')
  assert order[-1]=='fresh';order.append('fit')
 def maintain(*args,**kwargs):
  assert order==['discard']
  assert kwargs['extra_messages'][0]['content'][1]['image_url']['url']=='momo-observation:pending'
  order.append('maintain')
 monkeypatch.setattr(computer_tools,'fit_observation',fit)
 monkeypatch.setattr(computer_tools,'discard_observation',lambda:order.append('discard'),raising=False)
 monkeypatch.setattr(computer_tools,'observation_budget',lambda:['new-reservation'])
 monkeypatch.setattr(turn.compress,'guard_request',maintain)
 result=turn._fit_pending_observation(Messages(),{},[],game_event=True,cancelled=lambda:False)
 assert result==['new-reservation'] and order==['discard','maintain','fresh','fit']


def test_owner_screen_reaction_does_not_wait_with_old_pixels(monkeypatch):
 monkeypatch.setattr(computer_tools,'fit_observation',lambda *a:(_ for _ in ()).throw(vision.VisionError('computer.budget')))
 monkeypatch.setattr(turn.compress,'guard_request',lambda *a,**k:pytest.fail('old screen frame entered maintenance'))
 with pytest.raises(vision.VisionError,match='computer.budget'):
  turn._fit_pending_observation([],{},[],game_event=False,cancelled=lambda:False)


def test_game_frame_revocation_during_maintenance_prevents_recapture(monkeypatch):
 class Messages(list):
  def refresh_observation(self):pytest.fail('revoked run recaptured game pixels')
 monkeypatch.setattr(computer_tools,'fit_observation',lambda *a:(_ for _ in ()).throw(vision.VisionError('computer.budget')))
 monkeypatch.setattr(computer_tools,'discard_observation',lambda:None)
 monkeypatch.setattr(turn.compress,'guard_request',lambda *a,**k:None)
 with pytest.raises(llm.LlmError,match='cancelled'):
  turn._fit_pending_observation(Messages(),{},[],game_event=True,cancelled=lambda:True)
