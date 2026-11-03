"""Real model-tool/coordinator/Cordis/native-worker stack; only QQNT SDK is synthetic."""
import json
import base64
from pathlib import Path
import shutil
import time
import pytest
from app.core import db
from app.core.plugin_host import PluginHost
from app.services import capability,checkpoint,coordinator,social_media,social_tools
from app.services.coordinator import Coordinator
from app.services.social import social
from conftest import configured_native_social
ROOT=Path(__file__).resolve().parents[2]

@pytest.fixture
def full_chain(tmp_path,monkeypatch):
    node=shutil.which('node')
    if not node:pytest.skip('Node runtime not installed')
    monkeypatch.setenv('MOMO_NODE',node)
    monkeypatch.setenv('MOMO_PLUGIN_HOST',str(ROOT/'plugin-host/test/fixtures/qq-full-host.mjs'))
    monkeypatch.delenv('MOMO_QQ_RUNTIME_CONFIG',raising=False)
    monkeypatch.setenv('QQ_FIXTURE_ROOT',str(tmp_path))
    configured_native_social(social,permissions={key:True for key in ('receive','reply','proactive','contacts','history','media','friendRequests','groups','groupManagement')},proactivePolicy={'recipientIds':['20002'],'quietStart':0,'quietEnd':0,'maxPerHour':60,'minIntervalSeconds':0},groupAllowlist=[{'peerId':'30003'}])
    core=Coordinator();core.schema();core.started=True;core.mode='meeting';core.epoch=1
    core.owner={'clientId':'fixture-client','leaseId':'fixture-lease','expiresAt':time.monotonic()+120}
    core.host=PluginHost(core.core_id,core.event,lambda:core.epoch)
    monkeypatch.setattr(coordinator,'runtime',core);monkeypatch.setattr(social_tools,'runtime',core)
    try:
        core.host.start()
        core.host.request('qq.runtime.begin',{'ownerAction':True,'expectedSelfId':'10001'})
        for _ in range(100):
            if core.host.request('qq.runtime.status').get('connected'):break
            time.sleep(.02)
        assert core.host.request('qq.runtime.status')['connected'] is True
        core.configure_host_plugins([])
        assert core.host.request('channels.health',{'pluginId':'momo-qq'})['status']=='connected'
        yield core,tmp_path/'native/sdk-calls.ndjson'
    finally:core.close()

def invoke(core,name,args):
    item=core.enqueue('meeting','fixture-local',name+'-'+str(time.monotonic_ns()),'Synthetic local tool request')
    with checkpoint.audience_scope('owner'),core.run(item['run_id'],client='fixture-client',lease='fixture-lease'):
        token=coordinator.current_run.set(item['run_id'])
        try:return json.loads(capability.run_call({'id':'fixture-call','type':'function','function':{'name':name,'arguments':json.dumps(args)}})['content'])
        finally:coordinator.current_run.reset(token)

def success(core,name,args):
    value=invoke(core,name,args);assert 'error' not in value,value
    if name!='qq_media_library':
        assert value['receipt']['status']=='completed',value
        rows=db.query('SELECT * FROM outbox WHERE command_id=?',(value['receipt']['commandId'],))
        assert len(rows)==1 and rows[0]['status']=='completed'
    return value

def test_six_capabilities_cross_real_coordinator_cordis_and_native_worker(full_chain):
    core,trace=full_chain
    assert success(core,'qq_contacts',{'limit':10})['result']['contacts']==[{'peerId':'20002','name':'Fixture u_peer','remark':''}]
    history=success(core,'qq_history',{'peerId':'20002','limit':10})
    assert history['result']['messages'][0]['text'].startswith('Synthetic history')
    assert 'QQ图片' in history['result']['messages'][0]['text']
    assert history['result']['messages'][0]['attachments'][0]['elementId']=='70001'
    private=success(core,'qq_send_private',{'peerId':'20002','text':'Synthetic proactive hello'})
    assert private['receipt']['deliveryStatus']=='provider_accepted'
    assert private['receipt']['externalMessageId'].startswith('message-')
    upload=social_media.store('note.txt','text/plain',b'synthetic upload')
    assert success(core,'qq_media_library',{})['items']==[upload]
    assert success(core,'qq_send_media',{'peerId':'20002','mediaId':upload['mediaId']})['receipt']['externalMessageId'].startswith('message-')
    picture=social_media.store('dot.png','image/png',base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iXioAAAAASUVORK5CYII='))
    success(core,'qq_send_media',{'peerId':'20002','mediaId':picture['mediaId']})
    fetched=success(core,'qq_fetch_media',{'peerId':'20002','messageId':'90001','elementId':'70001'})
    assert fetched['result']['name']=='fixture.txt'
    assert social_media.payload(fetched['result']['mediaId'])['dataBase64']=='Zml4dHVyZSBieXRlcw=='
    request=success(core,'qq_friend_requests',{'limit':10})['result']['requests'][0]
    assert request['requestId']=='u_request:1700000000'
    success(core,'qq_respond_friend_request',{'peerId':request['peerId'],'requestId':request['requestId'],'approve':True})
    assert success(core,'qq_friend_requests',{'limit':10})['result']['requests']==[]
    assert success(core,'qq_groups',{'limit':10})['result']['groups'][0]['peerId']=='group:30003'
    assert len(success(core,'qq_group_members',{'peerId':'group:30003','limit':10})['result']['members'])==2
    success(core,'qq_send_group',{'peerId':'group:30003','text':'Synthetic group hello'})
    success(core,'qq_manage_group',{'peerId':'group:30003','operation':'setName','name':'Renamed fixture'})
    success(core,'qq_manage_group',{'peerId':'group:30003','operation':'muteMember','memberId':'20002','durationSeconds':60})
    success(core,'qq_manage_group',{'peerId':'group:30003','operation':'muteAll','enabled':True})
    success(core,'qq_manage_group',{'peerId':'group:30003','operation':'muteAll','enabled':False})
    success(core,'qq_manage_group',{'peerId':'group:30003','operation':'kickMember','memberId':'20002'})
    assert len(success(core,'qq_group_members',{'peerId':'group:30003','limit':10})['result']['members'])==1
    calls=[json.loads(line) for line in trace.read_text().splitlines()]
    assert {'getBuddyListV2','getMsgsIncludeSelf','sendMsg','downloadRichMedia','getBuddyReq','approvalFriendRequest','getGroupList','getAllMemberList','modifyGroupName','setMemberShutUp','setGroupShutUp','kickMember'} <= {row['method'] for row in calls}
    assert [row['elementTypes'] for row in calls if row['method']=='sendMsg']==[[1],[3],[2],[1]]
    assert all(json.loads(row['receipt'])['commandId']==row['command_id'] for row in db.query('SELECT * FROM outbox'))

def test_scope_permission_revocation_and_focus_block_the_real_native_path(full_chain):
    core,trace=full_chain
    success(core,'qq_contacts',{});before=trace.read_text()
    assert invoke(core,'qq_send_private',{'peerId':'40004','text':'Not permitted'})['ok'] is False
    assert invoke(core,'qq_manage_group',{'peerId':'group:50005','operation':'setName','name':'Not permitted'})['ok'] is False
    assert trace.read_text()==before
    social.put('qq',{'permissions':{'contacts':False}})
    assert invoke(core,'qq_contacts',{})['ok'] is False
    assert trace.read_text()==before
    with core.condition:core.focus=True
    try:assert invoke(core,'qq_history',{'peerId':'20002'})['ok'] is False
    finally:
        with core.condition:core.focus=False
    assert trace.read_text()==before
    social.put('qq',{'groupAllowlist':[]})
    assert invoke(core,'qq_send_group',{'peerId':'group:30003','text':'No allowed groups'})['ok'] is False
    assert trace.read_text()==before
    assert len(db.query('SELECT * FROM outbox'))==1


@pytest.mark.parametrize('approve',[True,False])
def test_friend_decisions_require_actual_pending_native_request(full_chain,approve):
    core,_=full_chain
    request=success(core,'qq_friend_requests',{})['result']['requests'][0]
    success(core,'qq_respond_friend_request',{'peerId':request['peerId'],'requestId':request['requestId'],'approve':approve})
    assert success(core,'qq_friend_requests',{})['result']['requests']==[]
    assert invoke(core,'qq_respond_friend_request',{'peerId':request['peerId'],'requestId':request['requestId'],'approve':approve})['ok'] is False


def test_local_chat_interruption_hold_does_not_disable_its_own_authorized_qq_tools(full_chain):
    core,trace=full_chain
    core.prepare_local('fixture-client','fixture-lease')
    assert core.interrupt_hold is True
    assert success(core,'qq_contacts',{})['result']['contacts']


@pytest.mark.parametrize('model_result', ['success', 'error', 'empty'])
def test_group_inbox_uses_separate_audience_and_replies_through_real_worker(full_chain,monkeypatch,model_result):
    import threading
    from app.core import llm
    core,trace=full_chain
    def model(_config,messages,**kwargs):
        content='\n'.join(str(m.get('content','')) for m in messages)
        assert 'QQ group' in content or 'QQ 群' in content
        if model_result == 'error':
            raise llm.LlmError('synthetic upstream failure')
        if model_result == 'success':
            yield {'type':'text','delta':'Synthetic group reply.'}
    monkeypatch.setattr(llm,'chat_stream',model)
    account=social._account('qq')
    core.event('inbox',{'source':'qq','pluginId':'momo-qq','accountId':account['accountId'],'selfId':'10001','peerId':'group:30003','groupId':'30003','senderId':'20002','conversationKind':'group','externalMessageId':'group-live-inbox','text':'Synthetic group incoming','policyRevision':account['policyRevision']})
    worker=threading.Thread(target=core._worker,daemon=True);worker.start()
    try:
        deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            rows=db.query("SELECT * FROM inbox WHERE raw_external_id='group-live-inbox'")
            if rows and rows[0]['status'] in {'completed','failed','interrupted','held_scope'}:break
            time.sleep(.02)
        assert rows and rows[0]['audience']!='owner'
        assert rows[0]['status']=='completed',dict(rows[0])
        replies = db.query("SELECT text FROM messages WHERE run_id=? AND role='assistant' AND visible=1", (rows[0]['run_id'],))
        assert len(replies)==1 and replies[0]['text']
        assert 'synthetic upstream failure' not in replies[0]['text']
        assert any(json.loads(row['payload']).get('peerId')=='group:30003' and row['status']=='completed' for row in db.query('SELECT * FROM outbox'))
    finally:
        core.closed.set();worker.join(2)


def test_remote_attachment_reply_does_not_require_proactive_grant(full_chain):
    core,trace=full_chain
    social.put('qq',{'permissions':{'proactive':False}})
    account=social._account('qq');audience=social._audience(account,'20002')
    upload=social_media.store('reply.txt','text/plain',b'scoped reply',audience=audience)
    item=core.enqueue('qq',account['accountId'],'remote-attach','Please return my attachment',peer_id='20002',sender_id='20002',self_id='10001',audience=audience,policy_revision=account['policyRevision'])
    with checkpoint.audience_scope(audience),core.run(item['run_id'],source='qq',account_id=account['accountId']):
        token=coordinator.current_run.set(item['run_id'])
        try:
            projected={tool['function']['name'] for tool in social_tools.declarations(source='qq')}
            assert 'qq_send_media' in projected and 'qq_send_private' not in projected
            result=json.loads(capability.run_call({'id':'remote-call','function':{'name':'qq_send_media','arguments':json.dumps({'peerId':'20002','mediaId':upload['mediaId']})}})['content'])
            assert result['receipt']['status']=='completed',result
        finally:coordinator.current_run.reset(token)


def test_local_qq_activity_indicator_does_not_change_owner_attention_authority(full_chain):
    core,_=full_chain
    item=core.enqueue('meeting','fixture-local','local-control','Stop phone work')
    with core.run(item['run_id'],client='fixture-client',lease='fixture-lease'):
        core.activity['toolSource']='qq'
        result=core.control('fixture-client','fixture-lease','local-control-stop','stop',item['run_id'],from_run=True)
        assert result['phonePaused'] is True


@pytest.mark.parametrize('vision_on',[True,False])
def test_current_image_crosses_cordis_and_native_without_history(full_chain,monkeypatch,vision_on):
    from app.core import state
    from app.services import dialogue_input, vision
    import base64
    core,trace=full_chain
    social.put('qq',{'permissions':{'history':False}})
    core.configure_host_plugins([])
    cfg=state.load()['settings']['llm'];cfg.update(url='http://vision.test',model='vision',vision=vision_on)
    vision.schema()
    with db.tx() as c:c.execute('INSERT INTO vision_proofs VALUES(?,?)',(vision.fingerprint(cfg),0))
    values=state.load();values['settings']['llm']=cfg;state.write_state(values)
    account=social._account('qq');audience=social._audience(account,'20002')
    item=core.enqueue('qq',account['accountId'],'90001','What color?',self_id='10001',peer_id='20002',sender_id='20002',audience=audience,policy_revision=str(account['policyRevision']),attachments=[{'kind':'image','elementId':'70002','messageId':'90001','name':'fixture.png','size':70},{'kind':'audio','elementId':'voice','messageId':'90001'}])
    with checkpoint.audience_scope(audience),core.run(item['run_id'],'qq',account_id=account['accountId']):
        token=coordinator.current_run.set(item['run_id'])
        try:
            original_action = core.social_action
            pcm = b'\x01\x00' * 1600
            def media_action(name, args):
                if args.get('elementId') == 'voice':
                    return {'result': {'dataBase64': base64.b64encode(pcm), 'mime': 'audio/x-momo-pcm16'}}
                return original_action(name, args)
            monkeypatch.setattr(core, 'social_action', media_action)
            monkeypatch.setattr(dialogue_input, 'transcribe', lambda raw, lang: 'voice fixture' if raw == pcm else '')
            content = dialogue_input.from_inbox(core, item)
            assert content.speech == ['voice fixture']
            ids = [image['id'] for image in vision.for_run(item['run_id'])]
            assert content.images == (ids if vision_on else [])
            assert len(ids)==1
            parts=vision.parts('color?',ids,audience=audience,cfg=cfg)
            if vision_on:
                assert vision.materialize([{'role':'user','content':parts}],cfg,audience)[0]['content'][-1]['image_url']['url'].startswith('data:image/jpeg;')
            else:
                assert all(part['type']!='image_url' for part in parts)
            # Receiving and displaying bytes does not depend on model vision.
            checkpoint.begin_turn('What color?',checkpoint.generation(),db.now_iso(),run_id=item['run_id'],source='qq',external_message_id=json.dumps([account['accountId'],'20002','90001']))
            from app.services import phone
            monkeypatch.setattr(phone,'runtime',core)
            projected=phone.qq_snapshot('20002')['messages'][0]['images']
            assert projected[0]['id']==ids[0]
            stored=db.query("SELECT * FROM messages WHERE run_id=? AND role='user'",(item['run_id'],))[0]
            assert checkpoint._message(stored)['images'][0]['id']==ids[0]
            clip = phone.qq_snapshot('20002')['messages'][0]['voices'][0]
            assert checkpoint._message(stored)['voices'] == [clip]
            assert dialogue_input.voice_wav(clip).endswith(pcm)
            assert 'voice fixture' in checkpoint.context_message(stored)['text']
            assert 'voice fixture' not in checkpoint._message(stored)['text']
            assert vision.body(ids[0])[0][:2]==b'\xff\xd8'
        finally:coordinator.current_run.reset(token)
    assert 'downloadRichMedia' in trace.read_text()
    assert social._account('qq')['permissions']['history'] is False


def test_grant_change_during_image_fetch_cannot_reach_model(full_chain,monkeypatch):
    import threading
    from app.core import llm
    from app.services import vision
    core,_=full_chain
    called=[]
    def revoked(*args):
        social.put('qq',{'permissions':{'media':False}})
        return []
    monkeypatch.setattr(vision,'qq_images',revoked)
    monkeypatch.setattr(llm,'chat_stream',lambda *a,**k:called.append(True) or iter([]))
    account=social._account('qq')
    core.event('inbox',{'source':'qq','accountId':account['accountId'],'selfId':'10001','peerId':'20002','senderId':'20002','conversationKind':'private','externalMessageId':'90001','text':'image','attachments':[{'kind':'image','elementId':'70002','messageId':'90001','size':70}],'policyRevision':account['policyRevision']})
    worker=threading.Thread(target=core._worker,daemon=True);worker.start()
    try:
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            rows=db.query("SELECT status FROM inbox WHERE raw_external_id='90001'")
            if rows and rows[0]['status']=='held_scope':break
            time.sleep(.02)
        assert rows[0]['status']=='held_scope'
        assert called==[]
    finally:core.closed.set();worker.join(2)
