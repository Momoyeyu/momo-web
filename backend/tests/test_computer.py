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
