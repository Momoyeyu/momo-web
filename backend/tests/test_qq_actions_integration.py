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
    assert history['result']['messages'][0]['text']=='Synthetic history'
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


def test_group_inbox_uses_separate_audience_and_replies_through_real_worker(full_chain,monkeypatch):
    import threading
    from app.core import llm
    core,trace=full_chain
    def model(_config,messages,**kwargs):
        content='\n'.join(str(m.get('content','')) for m in messages)
        assert 'QQ group' in content or 'QQ 群' in content
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
