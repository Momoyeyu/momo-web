"""Independent review regressions for full QQ coordinator integration."""
import json
import pytest
from app.core import db, state
from app.services.coordinator import Coordinator
from app.services.social import social, SocialError
from app.services import social_media
from conftest import configured_native_social


def test_unknown_reviewed_qq_mutation_is_selected_for_automatic_recovery():
    core=Coordinator();core.schema()
    payload={'method':'channels.action','pluginId':'momo-qq','accountId':'qq-main','action':'groups.manage','peerId':'group:20002'}
    with db.tx() as connection:
        connection.execute('INSERT INTO outbox VALUES(?,?,?,?,?,?,?)',('review-action','review-run',0,'unknown',json.dumps(payload),None,db.now_iso()))
    assert [row['command_id'] for row,_ in core._qq_unknown_commands()]==['review-action']


def test_media_store_refuses_symlink_library_parent(tmp_path):
    configured_native_social(social,permissions={'media':True})
    outside=tmp_path/'outside';outside.mkdir()
    (state.DATA_DIR/'social-media').symlink_to(outside,target_is_directory=True)
    with pytest.raises((SocialError,OSError)):
        social_media.store('note.txt','text/plain',b'should stay private')
    assert list(outside.rglob('*.bin'))==[]


def test_fetched_media_does_not_land_in_rebound_account_library(monkeypatch):
    from app.services import coordinator
    from app.services.coordinator import CoordinationError
    configured_native_social(social,permissions={'media':True,'history':True})
    core=Coordinator();core.schema();core.started=True;core.mode='meeting'
    item=core.enqueue('meeting','local','review-media-event','look at this')
    core.active=item['run_id']
    monkeypatch.setattr(core,'valid_run',lambda run_id:True)
    monkeypatch.setattr(core,'command',lambda *args,**kwargs:{'result':{'dataBase64':'aGVsbG8=','name':'note.txt','mime':'text/plain','size':5},'receipt':{}})
    original_filter=social.filter_action_result
    def switch_after_filter(authorization,result):
        filtered=original_filter(authorization,result)
        social.put('qq',{'enabled':False,'expectedSelfId':'30003'})
        return filtered
    monkeypatch.setattr(social,'filter_action_result',switch_after_filter)
    token=coordinator.current_run.set(item['run_id'])
    try:
        with pytest.raises((SocialError,CoordinationError)):
            core.social_action('media.fetch',{'peerId':'20002','messageId':'message','elementId':'element'})
    finally:coordinator.current_run.reset(token)
    assert social_media.listing()==[]


def test_qq_owner_link_does_not_become_local_account_management_authority(monkeypatch):
    from app.services import coordinator
    configured_native_social(social,permissions={'contacts':True})
    core=Coordinator();core.schema();core.started=True;core.mode='meeting'
    item=core.enqueue('qq','qq-main','review-remote-event','show contacts',audience='owner')
    core.active=item['run_id'];monkeypatch.setattr(core,'valid_run',lambda run_id:True)
    called=[];monkeypatch.setattr(core,'command',lambda *args,**kwargs:called.append(args))
    token=coordinator.current_run.set(item['run_id'])
    try:
        with pytest.raises(SocialError):core.social_action('contacts.list',{})
        with pytest.raises(SocialError):core.social_action('contacts.list',{'localOwner':True})
    finally:coordinator.current_run.reset(token)
    assert called==[]


def test_query_stopped_after_native_result_does_not_store_attachment(monkeypatch):
    from app.services import coordinator
    from app.services.coordinator import CoordinationError
    configured_native_social(social,permissions={'media':True,'history':True})
    core=Coordinator();core.schema();core.started=True;core.mode='meeting'
    item=core.enqueue('meeting','local','review-stopped-media-event','look at this')
    core.active=item['run_id'];monkeypatch.setattr(core,'valid_run',lambda run_id:core.mode=='meeting')
    def stop_before_result(*args,**kwargs):
        core.focus=True;core.mode='dormant'
        return {'result':{'dataBase64':'aGVsbG8=','name':'note.txt','mime':'text/plain','size':5},'receipt':{}}
    monkeypatch.setattr(core,'command',stop_before_result)
    token=coordinator.current_run.set(item['run_id'])
    try:
        with pytest.raises((SocialError,CoordinationError)):
            core.social_action('media.fetch',{'peerId':'20002','messageId':'message','elementId':'element'})
    finally:coordinator.current_run.reset(token)
    assert social_media.listing()==[]
