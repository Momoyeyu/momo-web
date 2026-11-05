import pytest
from unittest.mock import patch
from app.services import activities

@pytest.fixture(autouse=True)
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(activities.state,'DATA_DIR',tmp_path)

def test_default_denied_and_enable_does_not_start_activity():
    assert not any(activities.snapshot()['enabled'].values())
    with pytest.raises(ValueError): activities.require_enabled('browser')
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

def test_invalid_and_corrupt_state_fail_closed(tmp_path):
    (tmp_path/'activity-plugins.json').write_text('{broken')
    assert not any(activities.snapshot()['enabled'].values())
    with pytest.raises(ValueError): activities.set_enabled('shell',True)
    with pytest.raises(ValueError): activities.set_enabled('computer','true')
