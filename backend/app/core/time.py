"""当前时刻信息：UTC 时间 + 本机时区。

common_time 能力与 prompt 时间锚点共用这一份实现；
capability.py 只是把它包装成 tool result。
"""
from __future__ import annotations

from datetime import datetime, timezone


def now_info() -> dict[str, str]:
    """返回 {"utc", "tz"}：utc 为完整 ISO 时间戳（到秒），tz 为本机时区名+偏移。"""
    now = datetime.now().astimezone()
    off = now.strftime("%z")  # +0800 / -0500
    tz = f"{now.tzname() or ''}{off[:3]}:{off[3:]}"  # CST+08:00
    return {
        "utc": now.astimezone(timezone.utc).isoformat(timespec="seconds"),
        "tz": tz,
    }
