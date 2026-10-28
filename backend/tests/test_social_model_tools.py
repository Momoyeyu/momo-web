import json
import pytest
from app.services import checkpoint
from app.services.social import social
from conftest import configured_native_social


def test_only_granted_qq_tools_are_projected_and_remote_cannot_get_admin(monkeypatch):
    from app.services import social_tools
    assert social_tools.declarations(source='meeting') == []
    configured_native_social(social, permissions={'contacts': True, 'history': True, 'proactive': True, 'media': True, 'groups': True, 'friendRequests': True, 'groupManagement': True})
    names=lambda source:{x['function']['name'] for x in social_tools.declarations(source=source)}
    assert {'qq_contacts','qq_history','qq_send_private','qq_send_group','qq_send_media','qq_friend_requests','qq_groups','qq_manage_group'} <= names('meeting')
    assert not {'qq_contacts','qq_send_private','qq_friend_requests','qq_manage_group'} & names('qq')
    social.put('qq', {'permissions': {'history': False}})
    assert 'qq_history' not in names('meeting')


def test_social_tool_uses_the_coordinator_not_direct_host(monkeypatch):
    from app.services import social_tools
    calls=[]
    monkeypatch.setattr(social_tools.runtime, 'social_action', lambda action,args: calls.append((action,args)) or {'ok':True})
    assert json.loads(social_tools.execute('qq_contacts',{'limit':12}))['ok'] is True
    assert calls==[('contacts.list',{'limit':12})]
    assert social_tools.execute('qq_unknown',{}) is None
