import pytest
from app.services import activities
from app.services.social import SocialAccounts, QQRuntimeError, SocialError

@pytest.mark.parametrize('platform',['linux','win32'])
def test_desktop_platform_blocks_unimplemented_native_plugins(monkeypatch, platform):
    monkeypatch.setenv('MOMO_DESKTOP_TOKEN','isolated-test')
    monkeypatch.setattr('sys.platform',platform)
    assert not activities.supported('computer')
    assert not activities.supported('browser')
    assert activities.supported('minecraft') is (platform != 'win32')
    if platform == 'win32':
        with pytest.raises(ValueError,match='not supported'):
            activities.set_enabled('minecraft',True)
    with pytest.raises(ValueError,match='not supported'):
        activities.set_enabled('computer',True)
    social=SocialAccounts()
    assert social.host_configs()==[]
    with pytest.raises(QQRuntimeError): social.managed_qq_runtime()
    with pytest.raises(SocialError): social.connect('qq')

def test_web_capabilities_unchanged(monkeypatch):
    monkeypatch.delenv('MOMO_DESKTOP_TOKEN',raising=False)
    monkeypatch.setattr('sys.platform','linux')
    assert activities.supported('computer')
    assert activities.supported('browser')
