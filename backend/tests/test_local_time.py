from datetime import datetime, timezone, timedelta
from app.core import time as clock


def test_local_time_is_explicit_24h_and_unambiguous(monkeypatch):
    class FixedDateTime:
        @classmethod
        def now(cls):
            return datetime(2026, 11, 5, 17, 30, tzinfo=timezone(timedelta(hours=8)))
    # Avoid the test runner's own local zone affecting the simulated host.
    class LocalDateTime(datetime):
        def astimezone(self, tz=None):
            return self if tz is None else super().astimezone(tz)
    FixedDateTime.now = classmethod(lambda cls: LocalDateTime(2026,11,5,17,30,tzinfo=timezone(timedelta(hours=8))))
    monkeypatch.setattr(clock, 'datetime', FixedDateTime)
    info=clock.now_info()
    assert info['local_24h']=='2026-11-05 17:30:00'
    assert info['tz']=='UTC+08:00' and info['time_of_day']=='afternoon'
    assert info['utc']=='2026-11-05T09:30:00+00:00'
    assert '17:30:00' in clock.time_anchor() and 'not old dialogue' in clock.time_anchor()


def test_negative_fractional_timezone_and_midnight(monkeypatch):
    class LocalDateTime(datetime):
        def astimezone(self, tz=None):
            return self if tz is None else super().astimezone(tz)
        @classmethod
        def now(cls):
            return cls(2026,11,5,0,15,tzinfo=timezone(timedelta(hours=-3,minutes=-30)))
    monkeypatch.setattr(clock,'datetime',LocalDateTime)
    assert clock.now_info()['tz']=='UTC-03:30'
    assert clock.now_info()['local_24h'].endswith('00:15:00')
    assert clock.now_info()['time_of_day']=='late night'
