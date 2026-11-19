"""Persistent availability, separate from temporary activity permissions."""
import json
import os
import sys
import tempfile
import threading
from ..core import state
from . import mods
from .app_permissions import web_preview

IDS = ('computer', 'browser', 'minecraft')
_lock = threading.RLock()


def supported(key):
    if not os.environ.get("MOMO_DESKTOP_TOKEN") or web_preview():
        return True
    if key == "minecraft" and sys.platform == "win32":
        return False
    return not (sys.platform != "darwin" and key in ("computer", "browser"))


def _preferences():
    try:
        data = json.loads((state.DATA_DIR / 'activity-plugins.json').read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def snapshot():
    from .app_permissions import native_desktop, permissions
    with _lock:
        data = _preferences()
        core_access = not native_desktop() or permissions.granted()
        return {'enabled': {
                    key: (bool(mods.integration_root('momo.minecraft')) if key == 'minecraft'
                          else core_access and data.get(key, True) is True) and supported(key)
                    for key in IDS
                },
                'supported': {key: supported(key) for key in IDS}}


def require_enabled(key):
    if not snapshot()['enabled'].get(key, False):
        raise ValueError('Activity plugin disabled')


def set_enabled(key, enabled):
    if key not in IDS or type(enabled) is not bool:
        raise ValueError('Invalid activity plugin')
    if enabled and not supported(key):
        raise ValueError('Activity is not supported on this platform')
    if key == 'minecraft':
        try:
            mods.set_enabled('momo.minecraft', enabled)
        except KeyError:
            raise ValueError('Install the Minecraft Mod first') from None
        return snapshot()
    with _lock:
        data = _preferences()
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
        if key == 'browser':
            from .browser import browser
            browser.stop('disabled')
        else:
            from .computer import computer
            computer.stop('disabled')
    return snapshot()
