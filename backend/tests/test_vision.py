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
