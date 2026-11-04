from types import SimpleNamespace
import pytest
from app.services.minecraft_auth import MinecraftAuth, MinecraftAuthError
class HTTP:
    def __init__(self, results): self.results=iter(results); self.calls=[]
    def request(self,*args,**kwargs):
        self.calls.append((args,kwargs)); value=next(self.results)
        return SimpleNamespace(status_code=200,json=lambda:value)
def test_device_rate_and_expiry(tmp_path):
    clock=[0]
    http=HTTP([{'device_code':'private','user_code':'visible','verification_uri':'https://microsoft.com/devicelogin','expires_in':60,'interval':5}])
    auth=MinecraftAuth('12345678-1234-1234-1234-123456789abc',tmp_path/'token',http,lambda:clock[0])
    assert 'device_code' not in auth.begin()
    assert auth.poll()=={'status':'pending'}
    assert len(http.calls)==1
    clock[0]=61
    with pytest.raises(MinecraftAuthError,match='expired'): auth.poll()
def test_validated_session_private_refresh(tmp_path):
    http=HTTP([{'Token':'xbox'},{'Token':'xsts','DisplayClaims':{'xui':[{'uhs':'hash'}]}},{'access_token':'minecraft','expires_in':3600},{'items':[{'name':'game_minecraft'}]},{'id':'a'*32,'name':'Player'}])
    path=tmp_path/'private'/'credential'
    auth=MinecraftAuth('12345678-1234-1234-1234-123456789abc',path,http)
    result=auth._exchange({'access_token':'oauth','refresh_token':'refresh'})
    assert result['profile']['name']=='Player'
    assert path.stat().st_mode & 0o777 == 0o600
    assert 'minecraft' not in path.read_text()
    auth.logout(); assert not path.exists()


def test_remembered_restart_is_local_only_then_refreshes_and_verifies(tmp_path):
    import json
    path=tmp_path/'credentials'
    client='12345678-1234-1234-1234-123456789abc'
    path.write_text(json.dumps({'clientId':client,'refreshToken':'private-refresh','profile':{'id':'a'*32,'name':'Player'}}))
    path.chmod(0o600)
    http=HTTP([{'access_token':'oauth','refresh_token':'rotated'}, {'Token':'xbox'}, {'Token':'xsts','DisplayClaims':{'xui':[{'uhs':'hash'}]}}, {'access_token':'minecraft','expires_in':3600}, {'items':[{'name':'game_minecraft'}]}, {'id':'a'*32,'name':'Player'}])
    restarted=MinecraftAuth(client,path,http)
    assert restarted.cached is None
    assert restarted.remembered()=={'id':'a'*32,'name':'Player'}
    assert http.calls==[]
    assert restarted.session()['accessToken']=='minecraft'
    assert len(http.calls)==6
    assert 'private-refresh' not in str(restarted.remembered())
    assert json.loads(path.read_text())['profile']['name']=='Player'


def test_remembered_rejects_wrong_client_permissions_and_invalid_refresh(tmp_path):
    import json
    path=tmp_path/'credentials'
    client='12345678-1234-1234-1234-123456789abc'
    record={'clientId':client,'refreshToken':'private','profile':{'id':'a'*32,'name':'Player'}}
    path.write_text(json.dumps(record));path.chmod(0o644)
    auth=MinecraftAuth(client,path,HTTP([{'error':'invalid_grant'}]))
    assert auth.remembered() is None
    path.chmod(0o600)
    other=MinecraftAuth('22345678-1234-1234-1234-123456789abc',path,HTTP([]))
    assert other.remembered() is None
    with pytest.raises(MinecraftAuthError):auth.session()
    assert not path.exists()
    assert auth.remembered() is None
