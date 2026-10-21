"""Fetch the fixed official Cubism runtime once; keep its cache out of version control."""
from __future__ import annotations

from threading import Lock

import httpx

from ..core import state

CORE_URL = 'https://cubism.live2d.com/sdk-web/core/05/live2dcubismcore.min.js'
_lock = Lock()


def runtime() -> bytes:
    path = state.DATA_DIR / 'cache/cubism-core-05.js'
    with _lock:
        if path.is_file():
            return path.read_bytes()
        response = httpx.get(CORE_URL, timeout=25, follow_redirects=True)
        body = response.content
        if response.status_code != 200 or not 10000 < len(body) < 1000000 or b'Live2DCubismCore' not in body:
            raise ValueError('Official Cubism runtime unavailable')
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix('.tmp')
        temp.write_bytes(body)
        temp.replace(path)
        return body
