"""Backend-only credential references for reviewed plugins.

Provider OAuth/OIDC verification belongs to the platform adapter. This store
accepts an already verified binding; it neither invents a provider nor exchanges
passwords. No HTTP endpoint or model tool exposes secrets from this module.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid

from . import state


class CredentialError(PermissionError):
    pass


class CredentialStore:
    def __init__(self, directory: Path | None = None):
        self.directory = directory
        self.lock = threading.RLock()

    def _root(self):
        if self.directory is not None: return self.directory
        # Separate from a life-directory swap and the backup allowlist. The dev
        # location is inside ignored .workbuddy; each profile has a distinct key.
        profile = hashlib.sha256(str(state.DATA_DIR.resolve()).encode()).hexdigest()[:20]
        return state.DATA_DIR.parent / '.workbuddy' / 'credentials' / profile

    def _path(self, ref):
        if not isinstance(ref, str) or not re.fullmatch(r'cred_[0-9a-f]{32}', ref):
            raise CredentialError('Credential reference is unavailable')
        return self._root() / (ref + '.json')

    def _prepare(self):
        root = self._root()
        # Do not follow an injected symlink for a private credential directory.
        for part in (root, *root.parents):
            if part.is_symlink(): raise CredentialError('Credential storage is unavailable')
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        return root

    def _read(self, ref):
        target = self._path(ref)
        try:
            root = self._root()
            if target.is_symlink() or any(part.is_symlink() for part in (root, *root.parents)): raise CredentialError('Credential storage is unavailable')
            if os.name != 'nt' and root.stat().st_mode & 0o077: raise CredentialError('Credential storage permissions are unsafe')
            if os.name != 'nt' and target.stat().st_mode & 0o077: raise CredentialError('Credential storage permissions are unsafe')
            data = json.loads(target.read_text(encoding='utf-8'))
            if data.get('ref') != ref or data.get('revoked'): raise CredentialError('Credential reference is unavailable')
            return data
        except CredentialError:
            raise
        except (OSError, ValueError, TypeError):
            raise CredentialError('Credential reference is unavailable') from None

    def _write(self, record):
        root = self._prepare()
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=root, prefix='.credential-', delete=False) as stream:
                temporary = Path(stream.name)
                os.chmod(temporary, 0o600)
                json.dump(record, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._path(record['ref']))
        finally:
            if temporary is not None: temporary.unlink(missing_ok=True)

    def put(self, *, provider, account_key, plugin_id, secret, declared_scopes, granted_scopes, expires_at=None):
        """Called only after provider validation and an explicit user grant."""
        if any(not isinstance(value, str) or not value for value in (provider, account_key, plugin_id)):
            raise CredentialError('A verified account binding is required')
        if not isinstance(secret, dict) or not secret or any(not isinstance(key, str) or not isinstance(value, str) for key, value in secret.items()):
            raise CredentialError('Credential value is invalid')
        if not isinstance(declared_scopes, (list, set, tuple)) or not isinstance(granted_scopes, (list, set, tuple)):
            raise CredentialError('Credential scopes are invalid')
        if any(not isinstance(scope, str) or not scope for scope in [*declared_scopes, *granted_scopes]):
            raise CredentialError('Credential scopes are invalid')
        if expires_at is not None and (not isinstance(expires_at, (int, float)) or not math.isfinite(expires_at) or expires_at <= time.time()):
            raise CredentialError('Credential is expired')
        ref = 'cred_' + uuid.uuid4().hex
        record = {'ref': ref, 'provider': provider, 'accountKey': account_key, 'pluginId': plugin_id,
                  'declared': sorted(set(declared_scopes)), 'granted': sorted(set(granted_scopes)),
                  'expiresAt': expires_at, 'revoked': False, 'secret': dict(secret)}
        with self.lock: self._write(record)
        return ref

    def metadata(self, ref):
        with self.lock:
            data = self._read(ref)
            return {key: data[key] for key in ('ref', 'provider', 'accountKey', 'pluginId', 'declared', 'granted', 'expiresAt')}

    def resolve(self, ref, *, plugin_id, required_scopes, activity_scopes):
        """Return a secret only to its bound backend plugin with all gates open."""
        with self.lock:
            data = self._read(ref)
            required = set(required_scopes)
            available = set(data['declared']) & set(data['granted']) & set(activity_scopes)
            if data['pluginId'] != plugin_id or not required or not required <= available:
                raise CredentialError('Credential permission is unavailable')
            if data.get('expiresAt') is not None and data['expiresAt'] <= time.time():
                raise CredentialError('Credential is expired')
            return dict(data['secret'])

    def revoke(self, ref):
        with self.lock:
            data = self._read(ref)
            data['revoked'] = True
            data['secret'] = {}
            self._write(data)


credentials = CredentialStore()
