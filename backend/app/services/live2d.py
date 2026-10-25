"""Fetch the fixed official Cubism runtime once; keep its cache out of version control."""
from __future__ import annotations

from threading import Lock
import os
from pathlib import Path

import httpx

from ..core import state

CORE_URL = 'https://cubism.live2d.com/sdk-web/core/05/live2dcubismcore.min.js'
_lock = Lock()


def runtime() -> bytes:
    if os.environ.get('MOMO_DESKTOP_TOKEN'):
        # Desktop serves the pinned Core from frontend assets; never download at runtime.
        path = Path(os.environ['MOMO_RESOURCES_DIR']) / 'live2d/live2dcubismcore.min.js'
        if not path.is_file():
            raise ValueError('Bundled Cubism runtime missing')
        return path.read_bytes()
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
