from unittest.mock import Mock
from app.services import minecraft_managed as managed


def test_public_status_does_not_expose_credentials(monkeypatch):
    auth = Mock()
    auth.cached = {'accessToken':'private','expiresAt':9999999999,'profile':{'name':'Momo','id':'a'*32}}
    instance = __import__('unittest.mock',fromlist=['MagicMock']).MagicMock()
    instance.status.return_value = {'running':False}
    monkeypatch.setattr(managed,'auth',lambda:auth)
    monkeypatch.setattr(managed,'instance',lambda:instance)
    monkeypatch.setattr(managed,'manifest_stamp',lambda _: 'verified')
    (instance.root / '.momo-qualified').read_text.return_value = 'verified'
    result = managed.status()
    assert result['authenticated']
    assert 'private' not in str(result)
    assert result['prepared']


def test_start_binds_verified_account_server_dimension(monkeypatch):
    session={'accessToken':'private','profile':{'name':'Momo','id':'a'*32}}
    auth=Mock();auth.session.return_value=session
    instance=Mock();instance.token='private-bridge'
    companion=Mock()
    monkeypatch.setattr(managed,'auth',lambda:auth)
    monkeypatch.setattr(managed,'instance',lambda:instance)
    monkeypatch.setattr(managed,'minecraft',companion)
    monkeypatch.setattr(managed,'status',lambda:{'running':True})
    monkeypatch.setattr(managed,'wait_ready',lambda _,**kwargs:None)
    assert managed.start('example.org:25565','minecraft:overworld',['game.observe'],'client','lease')['joinRequired']
    assert instance.launch.call_args.args == (session,)
    assert callable(instance.launch.call_args.kwargs['cancelled'])
    companion.connect.assert_called_once_with(17643,'private-bridge','example.org:25565/minecraft:overworld','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',['game.observe'],'client','lease')


def test_status_never_refreshes_auth_or_rehashes_resources(monkeypatch, tmp_path):
    instance = Mock();instance.root=tmp_path;instance.status.return_value={'running':False}
    (tmp_path/'manifest.json').write_text('{}')
    (tmp_path/'.momo-qualified').write_text(managed.manifest_stamp(tmp_path))
    auth=Mock();auth.cached=None
    monkeypatch.setattr(managed,'instance',lambda:instance)
    monkeypatch.setattr(managed,'auth',lambda:auth)
    monkeypatch.setattr(managed,'qualify',lambda _: (_ for _ in ()).throw(AssertionError('No full hashing on status')))
    assert managed.status()['prepared']
    assert not managed.status()['authenticated']
    auth.session.assert_not_called()
    (tmp_path/'manifest.json').write_text('{"changed":true}')
    assert not managed.status()['prepared']


def test_prepare_uses_product_resources_by_default(monkeypatch, tmp_path):
    monkeypatch.setenv('MOMO_RESOURCES_DIR',str(tmp_path/'packaged'))
    instance=Mock();instance.root=tmp_path/'instance';instance.root.mkdir()
    (instance.root/'manifest.json').write_text('{}')
    monkeypatch.setattr(managed,'instance',lambda:instance)
    monkeypatch.setattr(managed,'status',lambda:{'prepared':True})
    managed.prepare()
    instance.prepare.assert_called_once_with(tmp_path/'packaged/minecraft')


def test_restart_status_reports_remembered_not_authenticated(monkeypatch, tmp_path):
    from app.services.minecraft_auth import MinecraftAuth
    import json
    client='12345678-1234-1234-1234-123456789abc'
    credentials=tmp_path/'credentials'
    credentials.write_text(json.dumps({'clientId':client,'refreshToken':'private','profile':{'id':'a'*32,'name':'Player'}}))
    credentials.chmod(0o600)
    account=MinecraftAuth(client,credentials,http=Mock())
    instance=Mock();instance.root=tmp_path;instance.status.return_value={'running':False}
    monkeypatch.setattr(managed,'instance',lambda:instance)
    monkeypatch.setattr(managed,'auth',lambda:account)
    result=managed.status()
    assert result['remembered'] is True
    assert result['authenticated'] is False
    assert result['profile']['name']=='Player'
    assert 'private' not in str(result)
    account.http.request.assert_not_called()


def test_stop_cancels_blocked_refresh_without_launch_or_wait(monkeypatch):
    import threading
    import time
    entered=threading.Event();release=threading.Event()
    account=Mock();instance=Mock();companion=Mock()
    def refresh():
        entered.set();release.wait(3)
        return {'profile':{'id':'a'*32}}
    account.session.side_effect=refresh
    monkeypatch.setattr(managed,'auth',lambda:account)
    monkeypatch.setattr(managed,'instance',lambda:instance)
    monkeypatch.setattr(managed,'minecraft',companion)
    errors=[]
    def start():
        try:managed.start('example.org','minecraft:overworld',['game.observe'],'client','lease')
        except ValueError as error:errors.append(str(error))
    worker=threading.Thread(target=start);worker.start()
    assert entered.wait(1)
    before=time.monotonic()
    assert managed.stop()['stopping']
    assert time.monotonic()-before < .2
    release.set();worker.join(2)
    assert not worker.is_alive()
    instance.launch.assert_not_called()
    assert errors==['Minecraft startup cancelled']
    assert managed._starting is None


def test_stop_cancels_bridge_readiness_and_reclaims_instance(monkeypatch):
    import threading
    entered=threading.Event()
    account=Mock();account.session.return_value={'profile':{'id':'a'*32}}
    instance=Mock();companion=Mock()
    monkeypatch.setattr(managed,'auth',lambda:account)
    monkeypatch.setattr(managed,'instance',lambda:instance)
    monkeypatch.setattr(managed,'minecraft',companion)
    def wait_ready(_, cancelled):
        entered.set()
        for _ in range(100):
            if cancelled():raise ValueError('cancelled')
            __import__('time').sleep(.01)
    monkeypatch.setattr(managed,'wait_ready',wait_ready)
    errors=[]
    def start():
        try:managed.start('example.org','minecraft:overworld',['game.observe'],'client','lease')
        except ValueError as error:errors.append(str(error))
    worker=threading.Thread(target=start);worker.start();assert entered.wait(1)
    assert managed.stop()['stopping']
    worker.join(2)
    assert not worker.is_alive()
    instance.stop.assert_called_once()
    companion.connect.assert_not_called()
    assert errors==['cancelled']
