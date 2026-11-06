"""013 isolation: no player APIs, QQ login or player data."""
import asyncio,base64,io,json
import pytest,httpx
from PIL import Image
from app.core import db,state
from app.services import vision,checkpoint,turn
from app.services.context_policy import estimate
from app.services.archive import export_data,import_data

def png(size=(50,30),color='red'):
    out=io.BytesIO();Image.new('RGB',size,color).save(out,'PNG');return out.getvalue()

def configured():
    cfg={**state.DEFAULT_STATE['settings']['llm'],'url':'http://vision.invalid','model':'test','vision':True}
    vision.schema()
    with db.tx() as c:c.execute('INSERT INTO vision_proofs VALUES(?,?)',(vision.fingerprint(cfg),0))
    values=state.normalize_state({});values['settings']['llm']=cfg;state.write_state(values);return cfg

def test_pixels_metadata_bounds():
    out=io.BytesIO();im=Image.new('RGB',(2000,1000),'blue');exif=Image.Exif();exif[270]='private metadata';im.save(out,'JPEG',exif=exif)
    item=vision.store(out.getvalue());raw,mime=vision.body(item['id'])
    assert (item['width'],item['height'])==(1536,768)
    assert mime=='image/jpeg' and b'private metadata' not in raw
    for bad in [b'<svg></svg>',b'x'*(vision.MAX_BYTES+1),png((5000,4100))]:
        with pytest.raises(vision.VisionError):vision.store(bad)

def test_gif_scope_ids():
    out=io.BytesIO();Image.new('RGB',(10,10),'red').save(out,'GIF',save_all=True,append_images=[Image.new('RGB',(10,10),'blue')])
    item=vision.store(out.getvalue(),audience='contact:alice');assert item['animated']
    with pytest.raises(vision.VisionError):vision.validate_ids([item['id']],audience='owner')
    with pytest.raises(vision.VisionError):vision.validate_ids([item['id']]*2,audience='contact:alice')
    with pytest.raises(vision.VisionError):vision.body('../momo.yaml')

def test_proof_and_config_changes():
    cfg=configured();assert vision.enabled(cfg)
    for field in ['url','key','model']:assert not vision.enabled({**cfg,field:'different'})
    assert not vision.enabled({**cfg,'vision':False})
    from app.services import state as service
    with pytest.raises(ValueError):service.replace({'settings':{'llm':{**cfg,'model':'other'}}})

def test_ephemeral_payload_and_revocation():
    cfg=configured();item=vision.store(png());messages=[{'role':'user','content':vision.parts('look',[item['id']],audience='owner',cfg=cfg)}]
    sent=vision.materialize(messages,cfg,'owner')
    assert sent[0]['content'][-1]['image_url']['url'].startswith('data:image/jpeg;base64,')
    assert 'base64' not in json.dumps(messages) and estimate(messages)<10000
    assert estimate([{'role':'user','content':[{'type':'image_url','image_url':{'url':'x'*1000000},'vision_tokens':2048}]}])<3000
    cfg['vision']=False;values=state.load();values['settings']['llm']=cfg;state.write_state(values)
    with pytest.raises(vision.VisionError):vision.materialize(messages,cfg,'owner')

def test_history_compact_reopen_backup():
    cfg=configured();item=vision.store(png());gen=checkpoint.generation();at=db.now_iso()
    checkpoint.begin_turn('look',gen,at);rid=checkpoint.current_run(gen,at);vision.bind(rid,[item['id']],'owner')
    checkpoint.append_sentence('It is red.',gen,at);checkpoint.acknowledge(rid,'It is red.',gen);checkpoint.finish_turn(gen,at)
    assert checkpoint.live_messages()[0]['images'][0]['id']==item['id']
    assert 'momo-image:'+item['id'] in json.dumps(turn.build_messages(state.load(),'what color?'))
    compact=turn.build_messages(state.load(),'',for_compact=True)
    assert item['id'] in json.dumps(compact) and 'image_url' not in json.dumps(compact)
    assert json.loads(vision.read_tool({'imageId':item['id']}))=={'imageId':item['id']}
    with checkpoint.audience_scope('other'):
        with pytest.raises(vision.VisionError):vision.read_tool({'imageId':item['id']})
    vision.remove_draft(item['id']);assert vision.body(item['id'])
    backup=export_data();import_data(backup);assert vision.body(item['id'])

def test_image_only_turn(monkeypatch):
    cfg=configured();item=vision.store(png());seen=[]
    monkeypatch.setattr(turn.compress,'guard_request',lambda *a,**k:None);monkeypatch.setattr(turn.compress,'maybe_compress',lambda *a,**k:None)
    def stream(config,messages,**kwargs):seen.append(messages);yield {'type':'text','delta':'A red image.'}
    monkeypatch.setattr(turn.llm,'chat_stream',stream)
    events=list(turn.run_turn('',image_ids=[item['id']]))
    assert any(e.get('text')=='A red image.' for e in events)
    assert seen[0][-1]['content'][-1]['image_url']['url'].startswith('data:')
    assert 'base64' not in json.dumps(checkpoint.live_messages())

@pytest.mark.parametrize('mode',['success','ignored','timeout','auth'])
def test_probe_content_not_http(monkeypatch,mode):
    cfg={'url':'http://test.invalid','key':'private','model':'vision'}
    monkeypatch.setattr(vision.secrets,'choice',lambda _: '2')
    class Client:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def post(self,url,**kwargs):
            parts=kwargs['json']['messages'][0]['content'];assert '222222' not in parts[0]['text']
            assert Image.open(io.BytesIO(base64.b64decode(parts[1]['image_url']['url'].split(',')[1]))).size==(360,100)
            if mode=='timeout':raise httpx.ReadTimeout('timeout')
            return httpx.Response(401 if mode=='auth' else 200,json={'choices':[{'message':{'content':'222222' if mode=='success' else 'OK'}}]})
    monkeypatch.setattr(vision.httpx,'AsyncClient',Client);result=asyncio.run(vision.probe(cfg))
    assert result['ok']==(mode=='success') and vision.verified(cfg)==(mode=='success')

def test_deletion_is_durable_but_keeps_reference():
    configured();item=vision.store(png());gen=checkpoint.generation();at=db.now_iso()
    checkpoint.begin_turn('photo',gen,at);rid=checkpoint.current_run(gen,at);vision.bind(rid,[item['id']],'owner')
    checkpoint.append_sentence('red',gen,at);checkpoint.acknowledge(rid,'red',gen)
    vision.remove_image(item['id'])
    assert vision.for_run(rid)[0]['unavailable']
    with pytest.raises(vision.VisionError):vision.body(item['id'])
    assert 'image_url' not in json.dumps(turn.build_messages(state.load(),'what was it?'))


def test_incoming_qq_images_do_not_require_history_but_match_exact_event(monkeypatch):
    from app.services.social import social,SocialError
    from app.services.coordinator import Coordinator,current_run
    from conftest import configured_native_social
    configured()
    account=configured_native_social(social,permissions={'receive':True,'reply':True,'media':True,'history':False})
    raw=social._read();raw['qq']['ownerPeerId']='20002';social._write(raw)
    coordinator=Coordinator()
    refs=[{'kind':'image','elementId':'element1','messageId':'msg1','name':'photo.png','size':100}]
    incoming=coordinator.enqueue('qq',account['accountId'],'msg1','[image]',self_id='10001',peer_id='20002',sender_id='20002',audience='owner',policy_revision=str(account['policyRevision']),attachments=refs)
    token=current_run.set(incoming['run_id'])
    try:
        args={'peerId':'20002','messageId':'msg1','elementId':'element1'}
        assert social.authorize_action('media.incoming',args)['action']=='media.incoming'
        with pytest.raises(SocialError):social.authorize_action('media.fetch',args)
        with pytest.raises(SocialError):social.authorize_action('media.incoming',{**args,'elementId':'other'})
        def action(name,args):
            auth=social.authorize_action(name,args)
            raw={'name':'photo.png','mime':'image/png','dataBase64':base64.b64encode(png()).decode()}
            return {'result':social.filter_action_result(auth,raw)}
        monkeypatch.setattr(coordinator,'social_action',action)
        ids=vision.qq_images(coordinator,incoming)
        assert len(ids)==1 and vision.for_run(incoming['run_id'])[0]['id']==ids[0]
        social.put('qq',{'permissions':{'media':False}})
        with pytest.raises(vision.VisionError):vision.body(ids[0])
    finally:current_run.reset(token)


def test_transparent_image_preserves_black_details_on_white():
    source=Image.new('RGBA',(40,40),(0,0,0,0))
    for x in range(12,28):
        for y in range(12,28):source.putpixel((x,y),(0,0,0,255))
    out=io.BytesIO();source.save(out,'PNG');image=vision.store(out.getvalue())
    normalized=Image.open(io.BytesIO(vision.body(image['id'])[0]))
    assert min(normalized.getpixel((0,0)))>240
    assert max(normalized.getpixel((20,20)))<20

def test_binding_revocation_finishes_the_started_turn(monkeypatch):
    configured();item=vision.store(png())
    def revoked(*args,**kwargs):raise vision.VisionError('vision.unavailable')
    monkeypatch.setattr(vision,'bind',revoked)
    events=list(turn.run_turn('look',image_ids=[item['id']]))
    assert events[-1]['t']=='error' and events[-1]['message']=='vision.unavailable'
    assert db.query('SELECT status FROM runs')[-1]['status']=='failed'
    assert checkpoint.live_messages()==[]

def test_historical_pixels_yield_to_current_image_and_real_tool_budget():
    from app.services.context_policy import Budget
    cfg=configured();image=vision.store(png((1026,1026)));iid=image['id']
    messages=[{'role':'user','content':vision.parts('old',[iid],audience='owner',cfg=cfg)} for _ in range(4)]
    messages.append({'role':'user','content':vision.parts('current',[iid],audience='owner',cfg=cfg)})
    tools=[{'description':'tool specification '*200}]
    assert estimate(messages,tools)>Budget.from_config(cfg).safe
    vision.fit_history(messages,cfg,tools)
    assert estimate(messages,tools)<=Budget.from_config(cfg).safe
    assert any(p['type']=='image_url' for p in messages[-1]['content'])
    assert all(any(iid in p.get('text','') for p in m['content']) for m in messages)
    assert sum(p['type']=='image_url' for m in messages for p in m['content'])<5


def test_screenshot_reservation_sheds_old_pixels_but_retains_current_upload():
    cfg=configured()
    cfg.update(contextWindow=9000,maxOutputTokens=1000)
    image=vision.store(png((32,32)))
    messages=[{'role':'user','content':vision.parts(label,[image['id']],audience='owner',cfg=cfg)} for label in ('old','current')]
    reserve=[{'role':'user','content':[{'type':'image_url','image_url':{'url':'momo-observation:pending'},'vision_tokens':4096}]}]
    vision.fit_history(messages,cfg,extra_messages=reserve)
    assert not any(p['type']=='image_url' for p in messages[0]['content'])
    assert any(p['type']=='image_url' for p in messages[1]['content'])


def test_turn_observation_followup_keeps_saved_image_costs_and_reservation(monkeypatch):
    from app.services import computer_tools
    from app.services.native_control import native_control
    from app.services.coordinator import current_run
    cfg=configured()
    values=state.load()
    values['settings']['llm'].update(contextWindow=32000,maxOutputTokens=1000)
    state.write_state(values)
    item=vision.store(png((32,32)))
    gen=checkpoint.generation();at=db.now_iso()
    checkpoint.begin_turn('earlier image',gen,at)
    rid=checkpoint.current_run(gen,at)
    vision.bind(rid,[item['id']],'owner')
    checkpoint.append_sentence('Earlier red image.',gen,at)
    checkpoint.acknowledge(rid,'Earlier red image.',gen)
    checkpoint.finish_turn(gen,at)
    monkeypatch.setattr(computer_tools,'require_local',lambda:'observe-turn')
    monkeypatch.setattr(computer_tools,'declarations',lambda *_:[{'type':'function','function':{'name':'computer_observe','description':'Observe approved window','parameters':{'type':'object','properties':{}}}}])
    monkeypatch.setattr(native_control,'execute',lambda *a,**k:{'data':base64.b64encode(png((32,32))).decode(),'version':1})
    monkeypatch.setattr(native_control,'validate',lambda *_:None)
    monkeypatch.setattr(native_control,'bind_observation',lambda generation,version,dimensions:{'imageWidth':dimensions['width'],'imageHeight':dimensions['height'],'coordinateSpace':'image-pixels'})
    # Keep the real guard but suppress unrelated asynchronous background maintenance.
    monkeypatch.setattr(turn.compress,'maybe_compress',lambda *a,**k:False)
    guard=turn.compress.guard_request
    reservations=[]
    def checked_guard(*args,**kwargs):
        reservations.append(kwargs.get('extra_messages'))
        return guard(*args,**kwargs)
    monkeypatch.setattr(turn.compress,'guard_request',checked_guard)
    requests=[]
    def stream(config,messages,**kwargs):
        requests.append(messages)
        if len(requests)==1:
            yield {'type':'tool_calls','calls':[{'id':'observe','type':'function','function':{'name':'computer_observe','arguments':'{}'}}]}
        else:
            assert sum(p.get('type')=='image_url' for m in messages if isinstance(m.get('content'),list) for p in m['content'])==2
            assert 'vision_tokens' not in json.dumps(messages)
            assert 'momo-observation:' not in json.dumps(messages)
            yield {'type':'text','delta':'The approved window is visible.'}
    monkeypatch.setattr(turn.llm,'chat_stream',stream)
    token=current_run.set('observe-turn')
    try: events=list(turn.run_turn('Observe the approved window.'))
    finally: current_run.reset(token)
    assert not [e for e in events if e['t']=='error']
    assert any(e.get('text')=='The approved window is visible.' for e in events)
    assert not reservations[0] and reservations[1]
    assert 'base64' not in json.dumps(checkpoint.live_messages())


def test_observation_capacity_maintenance_finishes_before_fresh_capture(monkeypatch):
    from types import SimpleNamespace
    from app.services import computer_tools
    from app.services.native_control import native_control
    from app.services.coordinator import current_run
    configured();values=state.load();values['settings']['llm']['contextWindow']=100000;state.write_state(values)
    now=[0];captures=[];requests=[]
    monkeypatch.setattr(computer_tools,'time',SimpleNamespace(monotonic=lambda:now[0]))
    monkeypatch.setattr(computer_tools,'require_local',lambda:'preflight-turn')
    monkeypatch.setattr(computer_tools,'declarations',lambda *_:[])
    monkeypatch.setattr(native_control,'validate',lambda *_:None)
    monkeypatch.setattr(native_control,'bind_observation',lambda generation,version,dimensions:{'imageWidth':dimensions['width'],'imageHeight':dimensions['height'],'coordinateSpace':'image-pixels'})
    def capture(*args,**kwargs):
        captures.append(now[0]);return {'data':base64.b64encode(png()).decode(),'version':1}
    monkeypatch.setattr(native_control,'execute',capture)
    real_guard=turn.compress.guard_request
    def guard(*args,**kwargs):
        if kwargs.get('extra_messages') and not captures:now[0]+=20
        return real_guard(*args,**kwargs)
    monkeypatch.setattr(turn.compress,'guard_request',guard)
    monkeypatch.setattr(turn.compress,'maybe_compress',lambda *a,**k:False)
    def stream(config,messages,**kwargs):
        requests.append(messages)
        if len(requests)==1:yield {'type':'tool_calls','calls':[{'id':'observe','type':'function','function':{'name':'computer_observe','arguments':'{}'}}]}
        else:yield {'type':'text','delta':'Fresh observation received.'}
    monkeypatch.setattr(turn.llm,'chat_stream',stream)
    token=current_run.set('preflight-turn')
    try:events=list(turn.run_turn('Observe.'))
    finally:current_run.reset(token)
    assert captures==[20]
    assert any(e.get('text')=='Fresh observation received.' for e in events)
    assert not [e for e in events if e['t']=='error']


def test_observation_preflight_capacity_failure_never_captures_or_claims_pixels(monkeypatch):
    from app.services import computer_tools
    from app.services.native_control import native_control
    from app.services.coordinator import current_run
    from app.core.llm import LlmError
    configured()
    captures=[];requests=[]
    monkeypatch.setattr(computer_tools,'require_local',lambda:'denied-preflight')
    monkeypatch.setattr(computer_tools,'declarations',lambda *_:[])
    monkeypatch.setattr(native_control,'execute',lambda *a,**k:captures.append(True))
    real_guard=turn.compress.guard_request
    def guard(*args,**kwargs):
        if kwargs.get('extra_messages'):raise LlmError('Context capacity reached; please retry after maintenance')
        return real_guard(*args,**kwargs)
    monkeypatch.setattr(turn.compress,'guard_request',guard)
    monkeypatch.setattr(turn.compress,'maybe_compress',lambda *a,**k:False)
    def stream(config,messages,**kwargs):
        requests.append(messages)
        if len(requests)==1:yield {'type':'tool_calls','calls':[{'id':'observe','type':'function','function':{'name':'computer_observe','arguments':'{}'}}]}
        else:
            result=json.loads(messages[-1]['content'])
            assert result['code']=='COMPUTER_CONTEXT_CAPACITY' and not result.get('pixelsFollow')
            yield {'type':'text','delta':'Observation is unavailable at this context capacity.'}
    monkeypatch.setattr(turn.llm,'chat_stream',stream)
    token=current_run.set('denied-preflight')
    try:events=list(turn.run_turn('Observe.'))
    finally:current_run.reset(token)
    assert not captures
    assert any(e.get('text')=='Observation is unavailable at this context capacity.' for e in events)


@pytest.mark.parametrize('available,expected_edge', [(7000,1024),(4000,512),(2500,None)])
@pytest.mark.parametrize('initial_bounds',[None,{'width':1536,'height':200}])
def test_default_32k_turn_selects_readable_resolution_with_real_guard(monkeypatch,available,expected_edge,initial_bounds):
    from app.services import computer_tools
    from app.services.native_control import native_control
    from app.services.coordinator import current_run
    from app.services.context_policy import Budget
    configured();values=state.load();values['settings']['llm'].update(contextWindow=32768,maxOutputTokens=4096);state.write_state(values)
    cfg=values['settings']['llm'];budget=Budget.from_config(cfg)
    monkeypatch.setattr(turn,'build_system_prompt',lambda *a,**k:'')
    overhead=estimate(turn.build_messages(values,'Observe.'),turn.TOOLS)
    header_size=budget.safe-available-overhead
    monkeypatch.setattr(turn,'build_system_prompt',lambda *a,**k:'H'*header_size)
    assert estimate(turn.build_messages(values,'Observe.'),turn.TOOLS)==budget.safe-available
    monkeypatch.setattr(computer_tools,'require_local',lambda:'adaptive-turn')
    monkeypatch.setattr(computer_tools,'declarations',lambda *_:[])
    # A narrow window may become square before the helper captures it.
    monkeypatch.setattr(native_control,'target',{'bounds':initial_bounds} if initial_bounds else None)
    monkeypatch.setattr(native_control,'validate',lambda *_:None)
    monkeypatch.setattr(native_control,'bind_observation',lambda generation,version,dimensions:{'imageWidth':dimensions['width'],'imageHeight':dimensions['height'],'coordinateSpace':'image-pixels'})
    captured=[];requests=[]
    raw=png((1600,1600))
    def capture(*args,**kwargs):
        captured.append(True);return {'data':base64.b64encode(raw).decode(),'version':1}
    monkeypatch.setattr(native_control,'execute',capture)
    # No old prefix exists to summarize; the real hard guard must try smaller images.
    monkeypatch.setattr(turn.compress,'maybe_compress',lambda *a,**k:False)
    def stream(config,messages,**kwargs):
        requests.append(messages)
        if len(requests)==1:
            yield {'type':'tool_calls','calls':[{'id':'observe','type':'function','function':{'name':'computer_observe','arguments':'{}'}}]}
        else:
            if expected_edge is None:
                assert json.loads(messages[-1]['content'])['code']=='COMPUTER_CONTEXT_CAPACITY'
            else:
                receipt=json.loads(next(m['content'] for m in messages if m.get('role')=='tool'))
                assert receipt['imageWidth']==receipt['imageHeight']==expected_edge
                image=messages[-1]['content'][-1]['image_url']['url'].split(',')[1]
                assert Image.open(io.BytesIO(base64.b64decode(image))).size==(expected_edge,expected_edge)
            yield {'type':'text','delta':'Observation handling finished.'}
    monkeypatch.setattr(turn.llm,'chat_stream',stream)
    token=current_run.set('adaptive-turn')
    try:events=list(turn.run_turn('Observe.'))
    finally:
        computer_tools._pending.pop('adaptive-turn',None)
        current_run.reset(token)
    assert len(captured)==(0 if expected_edge is None else 1)
    assert not [e for e in events if e['t']=='error']


def test_proactive_turn_reduces_large_snapshot_without_waiting_or_resetting_ttl(monkeypatch):
    from app.services import computer_tools
    from app.services.coordinator import current_run
    from app.services.context_policy import Budget
    configured();values=state.load();values['settings']['llm'].update(contextWindow=32768,maxOutputTokens=4096);state.write_state(values)
    cfg=values['settings']['llm'];observation={'source':'fixture','observedAt':1}
    monkeypatch.setattr(turn,'build_system_prompt',lambda *a,**k:'')
    overhead=estimate(turn.build_messages(values,'',observation=observation),[])
    header_size=Budget.from_config(cfg).safe-6000-overhead
    monkeypatch.setattr(turn,'build_system_prompt',lambda *a,**k:'H'*header_size)
    monkeypatch.setattr(computer_tools,'require_local',lambda:'reaction-turn')
    monkeypatch.setattr(computer_tools,'declarations',lambda *_:[])
    monkeypatch.setattr(turn.compress,'maybe_compress',lambda *a,**k:False)
    token=current_run.set('reaction-turn')
    try:
        computer_tools.stage(png((1600,1600)),lambda:None)
        deadline=computer_tools._pending['reaction-turn'][0]
        real_project=computer_tools.project
        def project(*args,**kwargs):
            assert computer_tools._pending['reaction-turn'][0]==deadline
            return real_project(*args,**kwargs)
        monkeypatch.setattr(computer_tools,'project',project)
        def stream(config,messages,**kwargs):
            assert kwargs['tools']==[]
            image=messages[-1]['content'][-1]['image_url']['url'].split(',')[1]
            assert Image.open(io.BytesIO(base64.b64decode(image))).size==(1024,1024)
            yield {'type':'text','delta':'The screen changed.'}
        monkeypatch.setattr(turn.llm,'chat_stream',stream)
        events=list(turn.run_turn('',observation=observation))
        assert any(e.get('text')=='The screen changed.' for e in events)
        assert not [e for e in events if e['t']=='error']
    finally:current_run.reset(token)
