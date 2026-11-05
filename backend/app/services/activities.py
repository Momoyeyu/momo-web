"""Persistent availability, separate from temporary activity permissions."""
import json
import os
import tempfile
import threading
from ..core import state

IDS = ('computer', 'browser', 'minecraft')
_lock = threading.RLock()


def snapshot():
    with _lock:
        try:
            data = json.loads((state.DATA_DIR / 'activity-plugins.json').read_text())
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict): data = {}
        return {'enabled': {key: data.get(key) is True for key in IDS}}


def require_enabled(key):
    if not snapshot()['enabled'].get(key, False):
        raise ValueError('Activity plugin disabled')


def set_enabled(key, enabled):
    if key not in IDS or type(enabled) is not bool:
        raise ValueError('Invalid activity plugin')
    with _lock:
        data = snapshot()['enabled']
        data[key] = enabled
        state.DATA_DIR.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=state.DATA_DIR, prefix='.activity-plugins-')
        try:
            with os.fdopen(fd, 'w') as output:
                json.dump(data, output)
            os.replace(name, state.DATA_DIR / 'activity-plugins.json')
        finally:
            if os.path.exists(name): os.unlink(name)
    # Publish disabled before waiting for runtime cleanup. A failed stop leaves
    # admission closed; repeating disable retries reclamation.
    if not enabled:
        from .native_control import native_control
        if native_control.plugin == key:
            native_control.stop("disabled")
        if key == 'minecraft':
            from .minecraft import minecraft
            minecraft.stop("disabled")
        elif key == 'browser':
            from .browser import browser
            browser.stop('disabled')
        else:
            from .computer import computer
            computer.stop('disabled')
    return snapshot()
