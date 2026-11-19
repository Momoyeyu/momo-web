import pytest
from unittest.mock import patch
from app.services import activities

@pytest.fixture(autouse=True)
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(activities.state,'DATA_DIR',tmp_path)

def test_core_tools_available_without_starting_activity():
    assert activities.snapshot()['enabled'] == {'computer': True, 'browser': True, 'minecraft': False}
    activities.require_enabled('browser')
    with patch('app.services.browser.browser.start') as start:
        activities.set_enabled('browser',True)
        activities.require_enabled('browser')
        start.assert_not_called()

def test_disable_publishes_before_cleanup_and_failed_stop_can_retry():
    activities.set_enabled('browser',True)
    def failed(*args):
        with pytest.raises(ValueError): activities.require_enabled('browser')
        raise RuntimeError('stop unconfirmed')
    with patch('app.services.browser.browser.stop',side_effect=failed):
        with pytest.raises(RuntimeError): activities.set_enabled('browser',False)
    assert not activities.snapshot()['enabled']['browser']
    with patch('app.services.browser.browser.stop') as stop:
        activities.set_enabled('browser',False)
        stop.assert_called_once()

def test_invalid_and_corrupt_state_use_core_availability(tmp_path):
    (tmp_path/'activity-plugins.json').write_text('{broken')
    assert activities.snapshot()['enabled'] == {'computer':True,'browser':True,'minecraft':False}
    with pytest.raises(ValueError): activities.set_enabled('shell',True)
    with pytest.raises(ValueError): activities.set_enabled('computer','true')


def test_desktop_consent_supplies_defaults_without_overwriting_plugin_choices(tmp_path, monkeypatch):
    from app.services import app_permissions
    policy = app_permissions.AppPermissions(tmp_path/'desktop-access.json')
    monkeypatch.setattr(app_permissions, 'permissions', policy)
    monkeypatch.setattr(app_permissions, 'native_desktop', lambda: True)
    monkeypatch.setattr(activities, 'supported', lambda _: True)
    monkeypatch.setattr(activities.mods, 'integration_root', lambda _: tmp_path)
    assert not activities.snapshot()['enabled']['computer']
    policy.consent(True)
    assert activities.snapshot()['enabled'] == {'computer':True,'browser':True,'minecraft':True}
    (tmp_path/'activity-plugins.json').write_text('{"computer":false,"minecraft":true}')
    assert activities.snapshot()['enabled'] == {'computer':False,'browser':True,'minecraft':True}

    policy.consent(False)
    assert not activities.snapshot()['enabled']['browser']


def test_authenticated_vite_uses_browser_capture_consent(monkeypatch):
    from app.services.app_permissions import native_desktop
    import sys
    monkeypatch.setattr(sys, 'platform', 'darwin')
    monkeypatch.setenv('MOMO_DESKTOP_TOKEN', 'web-proxy-test')
    monkeypatch.setenv('MOMO_WEB_ORIGIN', 'http://127.0.0.1:5177')
    assert not native_desktop()
    assert activities.snapshot()['enabled']['computer']
    monkeypatch.delenv('MOMO_WEB_ORIGIN')
    assert native_desktop()
    assert not activities.snapshot()['enabled']['computer']
