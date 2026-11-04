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
