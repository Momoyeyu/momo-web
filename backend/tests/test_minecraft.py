import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch
import pytest
from app.services.minecraft import Minecraft, MinecraftError

def active():
    m = Minecraft()
    m.binding = {'world':'private-test','account':'fixture'}
    m.permissions = {'game.observe','game.move'}
    m.epoch = 5
    m.fingerprint = 'verified'
    host = SimpleNamespace(control=threading.RLock(),request=Mock(return_value={'ok':True}))
    return m, SimpleNamespace(host=host, epoch=5)

def test_revoked_generation_never_dispatches():
    m, runtime = active()
    with patch('app.services.minecraft.runtime',runtime), patch.object(m,'gate',return_value='verified'):
        m.stop(notify=False)
        with pytest.raises(MinecraftError,match='revoked'): m.execute('follow',{},0,'owner','lease')
        runtime.host.request.assert_not_called()

def test_permissions_model_and_budget_gate():
    m, runtime = active()
    with patch('app.services.minecraft.runtime',runtime), patch.object(m,'gate',return_value='verified'):
        with pytest.raises(MinecraftError,match='denied'): m.execute('chat',{},0,'owner','lease')
        assert m.execute('observe',{},0,'owner','lease') == {'ok':True}
        m.actions = 120
        with pytest.raises(MinecraftError,match='budget'): m.execute('observe',{},0,'owner','lease')
    with patch('app.services.minecraft.runtime',runtime), patch.object(m,'gate',return_value='changed'):
        with pytest.raises(MinecraftError,match='revoked'): m.execute('observe',{},0,'owner','lease')

def test_attached_status_is_active_before_first_observe_and_inactive_after_stop():
    m = Minecraft()
    adapter = {'available': True, 'stopped': True, 'stopVerified': False}
    def request(method, params=None):
        if method == 'minecraft.stop':
            adapter.update(stopped=True, stopVerified=True)
        elif method == 'minecraft.configure':
            adapter.update(stopped=True, stopVerified=False)
        elif method == 'minecraft.observe':
            adapter.update(stopped=False, stopVerified=False)
            return {'observed': True}
        return dict(adapter)
    runtime = SimpleNamespace(host=SimpleNamespace(control=threading.RLock(), request=request), epoch=5)
    with patch('app.services.minecraft.runtime', runtime), patch.object(m, 'gate', return_value='verified'):
        assert m.status()['active'] is False
        status = m.connect(1234, 'x'*32, 'private-test', 'fixture', ['game.observe'], 'owner', 'lease')
        assert status['active'] is True
        assert status['stopped'] is True  # Transport has not executed an action yet.
        assert status['permissions'] == ['game.observe']
        assert m.execute('observe', {}, status['generation'], 'owner', 'lease') == {'observed': True}
        assert m.status()['active'] is True
        assert m.status()['stopped'] is False
        m.stop()
        assert m.status()['active'] is False
        assert m.status()['stopped'] is True
        assert m.status()['permissions'] == []

def test_binding_truth_overrides_adapter_status_without_exposing_identity():
    m, runtime = active()
    runtime.host.request.return_value = {'active': False, 'stopped': True}
    with patch('app.services.minecraft.runtime', runtime):
        status = m.status()
        assert status['active'] is True
        assert 'binding' not in status and 'world' not in status and 'account' not in status
        m.stop(notify=False)
        assert m.status()['active'] is False

def test_stop_invalidates_inflight_observation_generation():
    m, runtime = active()
    def request(method, params=None):
        if method == 'minecraft.observe':
            m.stop(notify=False)
            return {'observed': True}
        return {'stopped': True}
    runtime.host.request=request
    with patch('app.services.minecraft.runtime',runtime), patch.object(m,'gate',return_value='verified'):
        with pytest.raises(MinecraftError,match='Late Minecraft result'):
            m.execute('observe',{},m.generation,None,None)
        assert m.binding is None and not m.permissions
