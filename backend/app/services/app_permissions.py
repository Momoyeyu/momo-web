"""The local desktop consent and application blocklist."""
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import threading

from ..core import state


class DesktopPermissionError(ValueError):
    pass


def web_preview():
    # The authenticated Vite proxy and Electron both use a local bearer token.
    return bool(os.environ.get('MOMO_WEB_ORIGIN')) and not getattr(sys, 'frozen', False)


def native_desktop():
    return sys.platform == 'darwin' and bool(os.environ.get('MOMO_DESKTOP_TOKEN')) and not web_preview()


class AppPermissions:
    def __init__(self, path=None):
        self.path = Path(path) if path is not None else None
        self.lock = threading.RLock()
        self.version = 0

    def file(self):
        return self.path or state.DATA_DIR / 'desktop-access.json'

    def _read(self):
        try:
            fd = os.open(self.file(), os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {'granted': None, 'blocked': {}}
        with os.fdopen(fd, encoding='utf-8') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
                raise DesktopPermissionError('Invalid desktop permission store')
            data = json.load(stream)
        if not isinstance(data, dict) or type(data.get('granted')) is not bool or not isinstance(data.get('blocked'), dict):
            raise DesktopPermissionError('Invalid desktop permission store')
        return data

    def _update(self, change):
        with self.lock:
            data = self._read()
            if not change(data):
                return False
            path = self.file()
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, file = tempfile.mkstemp(prefix='.desktop-access-', dir=path.parent)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                    json.dump(data, stream, ensure_ascii=False)
                os.replace(file, path)
            finally:
                Path(file).unlink(missing_ok=True)
            self.version += 1
            return True

    def status(self):
        with self.lock:
            data = self._read()
            return {'granted': data['granted'], 'blocked': [
                {'bundleId': bundle_id, 'name': name} for bundle_id, name in sorted(data['blocked'].items())
            ]}

    def granted(self):
        try:
            with self.lock:
                return self._read()['granted'] is True
        except (OSError, ValueError):
            return False

    def consent(self, granted):
        def change(data):
            if data['granted'] is granted:
                return False
            data['granted'] = granted
            return True
        return self._update(change)

    def block(self, bundle_id, name, blocked):
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}', bundle_id):
            raise DesktopPermissionError('Invalid application bundle identifier')
        bundle_id = bundle_id.lower()

        def change(data):
            entries = data['blocked']
            if blocked and bundle_id not in entries:
                if len(entries) >= 128:
                    raise DesktopPermissionError('Application blocklist is full')
                entries[bundle_id] = name or bundle_id
                return True
            if not blocked and bundle_id in entries:
                del entries[bundle_id]
                return True
            return False
        return self._update(change)

    def before_action(self, target=None, version=None):
        with self.lock:
            data = self._read()
            if not data['granted']:
                raise DesktopPermissionError('Desktop access has not been granted')
            if version is not None and version != self.version:
                raise DesktopPermissionError('Desktop access has changed')
            if target is not None and target['bundleId'].lower() in data['blocked']:
                raise DesktopPermissionError('Application is on the desktop blocklist')
            return self.version, sorted(data['blocked'])


permissions = AppPermissions()
