"""Permissions are checked at projection and again at dispatch, never inferred from login."""
import pytest
from app.services.social import SocialAccounts, SocialError
from conftest import configured_native_social


def account(store, **changes):
    return configured_native_social(store, **changes)


def event(**changes):
    return dict(source='qq', accountId='qq-main', selfId='10001', peerId='20002', senderId='20002',
                conversationKind='private', externalMessageId='message-1', text='hello', **changes)


def test_new_grants_default_closed_and_survive_old_account_files():
    store = SocialAccounts()
    current = account(store)
    for permission in ['proactive','contacts','history','media','friendRequests','groups','groupManagement']:
        assert current['permissions'][permission] is False
    assert current['groupAllowlist'] == []
    assert current['proactivePolicy']['recipientIds'] == []
    raw = store._read(); raw['qq']['permissions'] = {'receive':True,'reply':True}; store._write(raw)
    assert store.get('qq')['permissions']['groups'] is False


def test_groups_require_explicit_group_scope_and_never_inherit_owner_memory():
    store = SocialAccounts(); account(store, permissions={'groups':True}, groupAllowlist=[{'peerId':'30003'}])
    raw=store._read();raw['qq']['ownerPeerId']='20002';store._write(raw)
    group={**event(), 'conversationKind':'group','peerId':'group:30003','groupId':'30003'}
    result=store.authorize_event(group)
    assert result and result['audience'] != 'owner'
    assert store.authorize_event({**group,'peerId':'group:40004','groupId':'40004'}) is None
    assert store.authorize_event({**group,'groupId':'40004'}) is None
    store.put('qq',{'permissions':{'groups':False}})
    assert store.authorize_event(group) is None


def test_media_ingress_requires_media_and_valid_opaque_attachments():
    store=SocialAccounts();account(store)
    media={**event(),'text':'','attachments':[{'mediaId':'opaque-media-id','kind':'image','name':'photo.png','size':123}]}
    assert store.authorize_event(media) is None
    store.put('qq',{'permissions':{'media':True}})
    admitted=store.authorize_event(media)
    assert admitted and admitted['text']
    assert store.authorize_event({**media,'attachments':[{'mediaId':'file:///etc/passwd','kind':'image'}]}) is None


def test_actions_obey_grants_current_revision_and_remote_recipient_isolation():
    store=SocialAccounts();current=account(store,permissions={'contacts':True,'history':True},allowlistEnabled=True,allowlist=[{'peerId':'20002'}])
    auth=store.authorize_action('contacts.list',{},local_owner=True)
    assert auth['action']=='contacts.list'
    assert store.filter_action_result(auth,{'contacts':[{'peerId':'20002','name':'allowed'},{'peerId':'30003','name':'other'}]}) == {'contacts':[{'peerId':'20002','name':'allowed'}]}
    remote=store._audience(store._account('qq'),'20002')
    with pytest.raises(SocialError):store.authorize_action('contacts.list',{},audience=remote)
    store.authorize_action('history.list',{'peerId':'20002'},audience=remote)
    with pytest.raises(SocialError):store.authorize_action('history.list',{'peerId':'30003'},audience=remote)
    with pytest.raises(SocialError):store.authorize_action('history.list',{'peerId':'20002'},revision=current['policyRevision']-1,local_owner=True)
    store.put('qq',{'permissions':{'history':False}})
    with pytest.raises(SocialError):store.authorize_action('history.list',{'peerId':'20002'},local_owner=True)


def test_proactive_requires_explicit_recipient_and_is_charged_once_at_dispatch(monkeypatch):
    store=SocialAccounts();account(store, permissions={'proactive':True},proactivePolicy={'recipientIds':['20002'],'maxPerHour':1,'minIntervalSeconds':0,'quietStart':0,'quietEnd':0})
    params={'peerId':'20002','text':'hi'}
    store.authorize_action('private.send',params,local_owner=True)
    with pytest.raises(SocialError):store.authorize_action('private.send',{'peerId':'30003','text':'hi'},local_owner=True)
    store.authorize_action('private.send',params,local_owner=True,consume=True,command_id='c1')
    store.authorize_action('private.send',params,local_owner=True,consume=True,command_id='c1')
    with pytest.raises(SocialError):store.authorize_action('private.send',params,local_owner=True,consume=True,command_id='c2')
    store.put('qq',{'permissions':{'proactive':False}})
    with pytest.raises(SocialError):store.authorize_action('private.send',params,local_owner=True,consume=True,command_id='c1')


def test_friend_and_group_management_need_separate_grants_and_local_owner():
    store=SocialAccounts();account(store,permissions={'friendRequests':True,'groups':True},groupAllowlist=[{'peerId':'30003'}])
    store.authorize_action('friends.listRequests',{},local_owner=True)
    with pytest.raises(SocialError):store.authorize_action('friends.respond',{'requestId':'r','peerId':'20002','approve':True},audience='social:other')
    with pytest.raises(SocialError):store.authorize_action('groups.manage',{'groupId':'30003','operation':'setName','name':'name'},local_owner=True)
    store.put('qq',{'permissions':{'groupManagement':True}})
    store.authorize_action('groups.manage',{'groupId':'30003','operation':'setName','name':'name'},local_owner=True)
    with pytest.raises(SocialError):store.authorize_action('groups.manage',{'groupId':'40004','operation':'setName','name':'name'},local_owner=True)
    with pytest.raises(SocialError):store.authorize_action('groups.manage',{'groupId':'30003','operation':'arbitraryMethod'},local_owner=True)


def test_nested_policy_edits_preserve_siblings_and_never_enable_account():
    store=SocialAccounts();current=store.put('qq',{'permissions':{'proactive':True},'proactivePolicy':{'recipientIds':['20002'],'maxPerHour':3}})
    store.put('qq',{'proactivePolicy':{'quietStart':1}})
    current=store.get('qq')
    assert current['proactivePolicy']=={'recipientIds':['20002'],'maxPerHour':3,'minIntervalSeconds':60,'quietStart':1,'quietEnd':8}
    assert not current['enabled']
    for change in [{'maxPerHour':True},{'quietStart':24},{'recipientIds':['bad']},{'unknown':1}]:
        with pytest.raises(SocialError):store.put('qq',{'proactivePolicy':change})


def test_consumed_proactive_receipt_is_preserved_but_read_results_recheck_revocation():
    store=SocialAccounts();account(store,permissions={'proactive':True,'contacts':True},proactivePolicy={'recipientIds':['20002'],'maxPerHour':1,'quietStart':0,'quietEnd':0})
    auth=store.authorize_action('private.send',{'peerId':'20002','text':'hi'},local_owner=True)
    store.authorize_action('private.send',auth['params'],local_owner=True,consume=True,command_id='c1')
    read=store.authorize_action('contacts.list',{},local_owner=True)
    store.put('qq',{'permissions':{'proactive':False,'contacts':False}})
    result=store.filter_action_result(auth,{'status':'completed','messageId':'native-1','rawToken':'must-not-leak','receipt':{'status':'completed','commandId':'c1','credential':'must-not-leak'}})
    assert result=={'status':'completed','messageId':'native-1','receipt':{'status':'completed','commandId':'c1'}}
    with pytest.raises(SocialError):store.filter_action_result(read,{'contacts':[]})


def test_group_alias_is_normalized_before_native_dispatch_and_member_reads_stay_scoped():
    store=SocialAccounts();account(store,permissions={'groups':True,'contacts':True,'history':True},groupAllowlist=[{'peerId':'30003'},{'peerId':'40004'}])
    auth=store.authorize_action('groups.members',{'groupId':'30003'},local_owner=True)
    assert auth['params']=={'peerId':'group:30003','limit':50}
    audience=store._audience(store._account('qq'),'group:30003')
    store.authorize_action('history.list',{'peerId':'group:30003'},audience=audience)
    with pytest.raises(SocialError):store.authorize_action('history.list',{'peerId':'group:40004'},audience=audience)
    with pytest.raises(SocialError):store.authorize_action('groups.members',{'peerId':'group:40004'},audience=audience)


def test_unknown_params_and_paths_are_not_native_escape_hatches():
    store=SocialAccounts();account(store,permissions={'media':True,'history':True,'proactive':True},proactivePolicy={'recipientIds':['20002'],'quietStart':0,'quietEnd':0})
    for action,params in [('media.send',{'peerId':'20002','mediaId':'image','path':'/etc/passwd'}),('media.send',{'peerId':'20002','mediaId':'https://example.com/image'}),('history.list',{'peerId':'20002','limit':500}),('history.list',{'peerId':'20002','rawApi':'anything'})]:
        with pytest.raises(SocialError):store.authorize_action(action,params,local_owner=True)


def test_quiet_hours_and_minimum_interval_use_local_clock_and_original_dispatch(monkeypatch):
    store=SocialAccounts();account(store,permissions={'proactive':True},proactivePolicy={'recipientIds':['20002'],'maxPerHour':6,'minIntervalSeconds':60,'quietStart':22,'quietEnd':8})
    from app.services import social_actions
    class Night:tm_hour=23
    monkeypatch.setattr(social_actions.time,'localtime',lambda:Night())
    with pytest.raises(SocialError):store.authorize_action('private.send',{'peerId':'20002','text':'hi'},local_owner=True)
    class Day:tm_hour=12
    monkeypatch.setattr(social_actions.time,'localtime',lambda:Day())
    store.authorize_action('private.send',{'peerId':'20002','text':'hi'},local_owner=True,consume=True,command_id='c1')
    with pytest.raises(SocialError):store.authorize_action('private.send',{'peerId':'20002','text':'hi2'},local_owner=True,consume=True,command_id='c2')
    assert 'proactiveAttempts' not in store.get('qq')
    assert 'proactiveAttempts' not in store.host_configs()[0]


def test_group_proactive_messages_use_explicit_groups_and_same_dispatch_quota():
    store=SocialAccounts();account(store,permissions={'groups':True,'media':True},groupAllowlist=[{'peerId':'30003'}],proactivePolicy={'quietStart':0,'quietEnd':0,'minIntervalSeconds':0,'maxPerHour':1})
    with pytest.raises(SocialError):store.authorize_action('group.send',{'peerId':'group:30003','text':'hi'},local_owner=True)
    store.put('qq',{'permissions':{'proactive':True}})
    store.authorize_action('group.send',{'peerId':'group:30003','text':'hi'},local_owner=True,consume=True,command_id='group-c1')
    with pytest.raises(SocialError):store.authorize_action('media.send',{'peerId':'group:30003','mediaId':'image'},local_owner=True,consume=True,command_id='group-c2')


def test_native_shapes_preserve_only_scoped_group_and_history_media_references():
    store=SocialAccounts();account(store,permissions={'groups':True,'history':True,'media':True},groupAllowlist=[{'peerId':'30003'}])
    groups=store.authorize_action('groups.list',{},local_owner=True)
    assert store.filter_action_result(groups,{'groups':[{'peerId':'group:30003','name':'group','role':'member'},{'peerId':'group:40004','name':'other'}]})=={'groups':[{'peerId':'group:30003','name':'group','role':'member'}]}
    history=store.authorize_action('history.list',{'peerId':'group:30003'},local_owner=True)
    result=store.filter_action_result(history,{'messages':[{'messageId':'m1','senderId':'20002','time':123,'text':'','nativeToken':'secret','attachments':[{'elementId':'e1','kind':'image','name':'photo','size':42,'path':'/private/secret'},{'elementId':'e2','kind':'image','size':20*1024*1024}]}]})
    assert result=={'messages':[{'messageId':'m1','senderId':'20002','time':123,'text':'','attachments':[{'elementId':'e1','kind':'image','name':'photo','size':42}]}]}
    incoming={**event(),'text':'','attachments':[{'elementId':'e1','messageId':'m1','kind':'image','name':'photo','size':42}]}
    assert store.authorize_event(incoming)


def test_native_friend_request_reference_can_be_used_without_accepting_arbitrary_paths():
    store=SocialAccounts();account(store,permissions={'friendRequests':True})
    params={'peerId':'20002','requestId':'u_friend_abc:1770000000','approve':True}
    assert store.authorize_action('friends.respond',params,local_owner=True)['params']==params
    for request_id in ['file:///private/key','https://example.com/r','../request','u_friend:']:
        with pytest.raises(SocialError):store.authorize_action('friends.respond',{**params,'requestId':request_id},local_owner=True)


def test_group_history_respects_enabled_person_allowlist_at_read_time():
    store=SocialAccounts();account(store,permissions={'groups':True,'history':True},groupAllowlist=[{'peerId':'30003'}],allowlistEnabled=True,allowlist=[{'peerId':'20002'}])
    auth=store.authorize_action('history.list',{'peerId':'group:30003'},local_owner=True)
    result=store.filter_action_result(auth,{'messages':[{'messageId':'a','senderId':'20002','text':'allowed'},{'messageId':'b','senderId':'40004','text':'not allowed'},{'messageId':'c','senderId':'10001','text':'momo sent'}]})
    assert [row['messageId'] for row in result['messages']]==['a','c']


def test_proactive_interval_survives_hour_window_cleanup_and_policy_reload(monkeypatch):
    from app.services import social_actions
    now=[100000.0];monkeypatch.setattr(social_actions.time,'time',lambda:now[0])
    store=SocialAccounts();account(store,permissions={'proactive':True},proactivePolicy={'recipientIds':['20002'],'quietStart':0,'quietEnd':0,'minIntervalSeconds':7200})
    store.authorize_action('private.send',{'peerId':'20002','text':'first'},local_owner=True,consume=True,command_id='old')
    now[0]+=3700
    with pytest.raises(SocialError):SocialAccounts().authorize_action('private.send',{'peerId':'20002','text':'too soon'},local_owner=True,consume=True,command_id='new')
