"""Host-local clock shared by the per-turn anchor and common_time tool.

The Web backend runs on the player's computer. UTC is supplementary, never a
value the model must convert to discover the player's current wall-clock time.
"""
from __future__ import annotations
from datetime import datetime, timezone


def now_info() -> dict[str, str]:
    now = datetime.now().astimezone()
    offset = now.strftime('%z')
    zone = f'UTC{offset[:3]}:{offset[3:]}'
    hour = now.hour
    period = ('late night' if hour < 5 else 'morning' if hour < 12 else
              'afternoon' if hour < 18 else 'evening' if hour < 22 else 'night')
    return {
        'local': now.isoformat(timespec='seconds'),
        'local_24h': now.strftime('%Y-%m-%d %H:%M:%S'),
        'time_of_day': period,
        'tz': zone,
        'utc': now.astimezone(timezone.utc).isoformat(timespec='seconds'),
    }


def time_anchor() -> str:
    info = now_info()
    return (f"Current player-computer local time (24-hour clock): {info['local_24h']}; "
            f"timezone {info['tz']}; local time of day: {info['time_of_day']}. "
            "Use this fresh clock for current-time statements, not old dialogue, summaries or memories. "
            "Hours 12–23 are after noon; hours 00–11 are before noon. Do not convert this local time again. "
            "This clock describes the host player, not the location of every external contact. "
            "Call common_time if you need a fresh precise reading; never infer a timezone from language.")
