"""User-trusted MCP bundles. Import is data-only; activation runs local Node code."""
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import threading
from ..core import state

class PluginRuntimeError(RuntimeError):
    """Desired disable persisted, but transport stop was not confirmed."""


_lock = threading.RLock()
CAPABILITIES = {'screen.observe', 'speech.proactive', 'computer.pointer', 'computer.keyboard', 'browser.navigate', 'network.access', 'files.read', 'files.write', 'game.observe', 'game.move', 'game.chat', 'game.modify'}


def _root():
    return state.DATA_DIR / 'plugins'


def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9-]{1,62}', value) or value.startswith('momo-'):
        raise ValueError('Invalid or reserved plugin id')
    return value


def _path(value):
    if not isinstance(value, str) or len(value) > 200 or not re.fullmatch(r'[a-zA-Z0-9_/-]+\.mjs', value) or any(p in ('', '..') for p in value.split('/')):
        raise ValueError('Invalid module path')
    return value


def validate(bundle):
    if not isinstance(bundle, dict) or set(bundle) != {'manifest', 'files'}:
        raise ValueError('Expected manifest and files')
    m = bundle['manifest']
    if not isinstance(m, dict) or set(m) != {'schemaVersion', 'id', 'version', 'name', 'description', 'entry', 'capabilities'}:
        raise ValueError('Invalid manifest fields')
    if type(m['schemaVersion']) is not int or m['schemaVersion'] != 1:
        raise ValueError('Unsupported schema version')
    _id(m['id'])
    if not isinstance(m['version'], str) or not re.fullmatch(r'\d{1,5}\.\d{1,5}\.\d{1,5}', m['version']):
        raise ValueError('Invalid release version')
    for key, limit in [('name', 80), ('description', 1000)]:
        value = m[key]
        if not isinstance(value, str) or not value.strip() or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('Invalid ' + key)
    _path(m['entry'])
    caps = m['capabilities']
    if not isinstance(caps, list) or any(not isinstance(c, str) or c not in CAPABILITIES for c in caps) or len(set(caps)) != len(caps):
        raise ValueError('Invalid capabilities')
    files = bundle['files']
    if not isinstance(files, dict) or not 1 <= len(files) <= 64 or m['entry'] not in files:
        raise ValueError('Missing entry or invalid files')
    for name, source in files.items():
        _path(name)
        if not isinstance(source, str):
            raise ValueError('Module source must be text')
    if len(json.dumps(bundle, ensure_ascii=False).encode()) > 2 * 1024 * 1024:
        raise ValueError('Bundle exceeds 2 MiB')
    return m


def listing():
    with _lock:
        records = []
        for path in sorted(_root().glob('*/record.json')):
            if path.parent.is_symlink() or path.is_symlink():
                continue
            records.append(json.loads(path.read_text()))
        return records


def _write(directory, record):
    temp = directory / '.record.tmp'
    temp.write_text(json.dumps(record, ensure_ascii=False))
    os.replace(temp, directory / 'record.json')


def install(bundle):
    m = validate(bundle)
    with _lock:
        root = _root()
        root.mkdir(parents=True, exist_ok=True)
        dest = root / m['id']
        if dest.exists() or dest.is_symlink():
            raise ValueError('Plugin already installed; remove before importing another version')
        temporary = Path(tempfile.mkdtemp(prefix='.import-', dir=root))
        try:
            for name, source in bundle['files'].items():
                target = temporary / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(source)
            record = {'manifest': m, 'enabled': False}
            _write(temporary, record)
            os.rename(temporary, dest)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        return record


def extensions():
    return [{'id': 'plugin-' + r['manifest']['id'], 'name': 'plugin_' + r['manifest']['id'], 'transport': 'stdio', 'command': 'node', 'args': [str(_root() / r['manifest']['id'] / r['manifest']['entry'])], 'enabled': True, 'env': {}} for r in listing() if r['enabled']]


def change(plugin_id, enabled=None, remove=False):
    _id(plugin_id)
    with _lock:
        directory = _root() / plugin_id
        if directory.is_symlink() or not (directory / 'record.json').is_file():
            raise ValueError('Plugin not installed')
        record = json.loads((directory / 'record.json').read_text())
        record['enabled'] = False if remove else enabled
        _write(directory, record)
        from .extend import configure
        try:
            synced = configure(state.load()['settings']['extensions'])
        except Exception:
            synced = False
        if not synced:
            record['enabled'] = False
            record['runtimeSynced'] = False
            record['runtimeStatus'] = 'stop-unconfirmed'
            record['pendingAction'] = 'remove' if remove else 'disable'
            record['runtimeError'] = 'Runtime synchronization failed; local plugin process stop is unconfirmed. Files retained. Retry disable or remove after the runtime recovers.'
            _write(directory, record)
            if enabled and not remove:
                # Withdraw the failed enable from the in-memory desired catalog too.
                # A later reconciliation must not resurrect a disk-disabled plugin.
                try:
                    rolled_back = configure(state.load()['settings']['extensions'])
                except Exception:
                    rolled_back = False
                if rolled_back:
                    for key in ('runtimeStatus', 'pendingAction', 'runtimeError'):
                        record.pop(key, None)
                    record['runtimeSynced'] = True
                    _write(directory, record)
                    raise PluginRuntimeError('Plugin enable failed; runtime has confirmed it is disabled.')
            raise PluginRuntimeError(record['runtimeError'])
        for key in ('runtimeStatus', 'pendingAction', 'runtimeError'):
            record.pop(key, None)
        record['runtimeSynced'] = True
        _write(directory, record)
        if remove:
            shutil.rmtree(directory)
            return {'removed': True, 'runtimeSynced': synced}
        return {**record, 'runtimeSynced': synced}
