import io
from unittest.mock import patch
import pytest
from PIL import Image
from app.services.computer import Computer, ComputerError


def frame():
    out = io.BytesIO()
    Image.new('RGB',(20,20),'white').save(out,'PNG')
    return out.getvalue()


def active():
    c = Computer()
    c.observing = True
    c.started_at = __import__('time').monotonic()
    c.source = 'test'
    return c


def test_stop_invalidates_frame_and_generation():
    c = active()
    with patch.object(c,'gate'):
        c.capture(frame(),0)
        c.stop()
        assert c.frame is None
        with pytest.raises(ComputerError,match='revoked'): c.capture(frame(),0)


def test_rate_and_total_budget():
    c = active()
    with patch.object(c,'gate'):
        c.capture(frame(),0)
        with pytest.raises(ComputerError,match='rate'): c.capture(frame(),0)
        c.frames = 120
        with pytest.raises(ComputerError,match='budget'): c.capture(frame(),0)
        assert not c.observing
        assert c.frame is None


def test_stale_generation_rejected_before_decoding():
    c = active()
    with patch.object(c,'gate'):
        with pytest.raises(ComputerError,match='revoked'): c.capture(b'invalid',9)


def test_reactions_require_flags_change_and_cooldown():
    c = active()
    c.signature = (150,) * 256
    c.unknown = False
    with patch.object(c,'gate'), patch('app.services.computer.runtime') as runtime:
        runtime.interrupt_hold = False
        runtime.active = runtime.presentation = None
        runtime.queue = []
        assert c.claim_reaction(0,'client','lease') is None
        c.proactive = c.reactions = True
        c.frame = b'private'
        c.last = __import__('time').monotonic()
        assert c.claim_reaction(0,'client','lease') == {'generation': 0}
        assert c.claim_reaction(0,'client','lease') is None
        c.last_reaction = 0
        assert c.claim_reaction(0,'client','lease') is None
        c.signature = (200,) * 256
        runtime.active = 'user-turn'
        assert c.claim_reaction(0,'client','lease') is None


def test_black_frame_does_not_react():
    c = active()
    c.proactive = c.reactions = True
    c.unknown = True
    with patch.object(c,'gate'), patch('app.services.computer.runtime'):
        assert c.claim_reaction(0,'client','lease') is None


def test_desktop_observation_needs_no_app_grant_and_never_creates_input_binding():
    import base64
    from types import SimpleNamespace
    from app.services import computer as module
    c = active()
    calls=[]
    host=SimpleNamespace(permit=lambda purpose:{'purpose':purpose},request=lambda method,params:(calls.append((method,params)) or {'data':base64.b64encode(frame()).decode()}))
    with patch.object(c,'gate'), patch.object(module.runtime,'host',host), patch('app.services.app_permissions.permissions.require',side_effect=AssertionError('No app approval for looking')):
        assert c.desktop_frame()['observationAvailable']
        assert [method for method,_ in calls] == ['native.screen']
        c.frames=120;c.last=0
        assert c.desktop_frame()['observationAvailable']
        c.set_desktop_allowed(False)
        with pytest.raises(ComputerError,match='paused'):c.desktop_frame()
        assert c.frame is None
    c.stop()


def test_stop_during_desktop_capture_discards_late_pixels():
    import base64
    from types import SimpleNamespace
    from app.services import computer as module
    c=active()
    def capture(*_):
        c.set_desktop_allowed(False)
        return {'data':base64.b64encode(frame()).decode()}
    host=SimpleNamespace(permit=lambda _: {},request=capture)
    with patch.object(c,'gate'),patch.object(module.runtime,'host',host):
        with pytest.raises(ComputerError,match='revoked'):c.desktop_frame()
        assert c.frame is None


def test_browser_share_uses_fresh_shared_pixels_without_native_capture():
    c=active();c.shared_source=True
    with patch.object(c,'gate'),patch('app.services.computer.runtime') as runtime:
        c.capture(frame(),0)
        assert c.desktop_frame()['observationAvailable']
        runtime.host.request.assert_not_called()
        c.last=0
        with pytest.raises(ComputerError,match='observationExpired'):c.desktop_frame()
    c.stop()


def test_preferences_survive_restart_without_observation_or_pixels():
    c = Computer()
    c.configure(True, True)
    c.set_desktop_allowed(False)
    c.frame = b'private pixels'
    c.observing = True
    fresh = Computer()
    fresh.reload_preferences()
    snapshot = fresh.snapshot(check=False)
    assert snapshot['proactive'] and snapshot['reactions']
    assert snapshot['desktopAllowed'] is False
    assert not snapshot['observing'] and not snapshot['observationAvailable']
    assert fresh.frame is None


def test_restore_reloads_preferences_and_discards_current_observation():
    from app.core import db
    c = Computer()
    c.configure(True, True)
    c.frame = b'private pixels'
    c.observing = True
    with db.tx() as connection:
        connection.execute("DELETE FROM meta WHERE key='computer_preferences'")
    c.reload_preferences()
    assert not c.proactive and not c.reactions and c.desktop_allowed
    assert c.frame is None and not c.observing
