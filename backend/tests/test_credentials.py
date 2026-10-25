import json
import os
from pathlib import Path
import time

import pytest

from app.core.credentials import CredentialError, CredentialStore, credentials
from app.services import archive


def put(store, **extra):
    return store.put(provider='verified-test-provider', account_key='issuer|subject', plugin_id='wechat', secret={'access_token': 'private-token', 'refresh_token': 'private-refresh'}, declared_scopes=['chat.read', 'chat.send'], granted_scopes=['chat.read', 'chat.send'], **extra)


def test_private_atomic_storage_and_opaque_metadata(tmp_path):
    store = CredentialStore(tmp_path / 'private')
    ref = put(store)
    assert ref.startswith('cred_') and 'private' not in ref
    metadata = store.metadata(ref)
    assert 'secret' not in metadata and 'token' not in json.dumps(metadata)
    assert store.resolve(ref, plugin_id='wechat', required_scopes=['chat.send'], activity_scopes=['chat.send']) == {'access_token': 'private-token', 'refresh_token': 'private-refresh'}
    if os.name != 'nt':
        assert (tmp_path / 'private').stat().st_mode & 0o777 == 0o700
        assert (tmp_path / 'private' / (ref + '.json')).stat().st_mode & 0o777 == 0o600
    assert not list((tmp_path / 'private').glob('.credential-*'))


@pytest.mark.parametrize('plugin,required,activity', [('other', ['chat.send'], ['chat.send']), ('wechat', ['chat.delete'], ['chat.delete']), ('wechat', ['chat.send'], ['chat.read']), ('wechat', [], ['chat.send'])])
def test_declared_granted_activity_intersection_is_required(tmp_path, plugin, required, activity):
    store = CredentialStore(tmp_path / 'private')
    ref = put(store)
    with pytest.raises(CredentialError, match='permission'):
        store.resolve(ref, plugin_id=plugin, required_scopes=required, activity_scopes=activity)


def test_ungranted_declared_scope_denied(tmp_path):
    store = CredentialStore(tmp_path / 'private')
    ref = store.put(provider='test', account_key='subject', plugin_id='plugin', secret={'token': 'private'}, declared_scopes=['read', 'write'], granted_scopes=['read'])
    with pytest.raises(CredentialError): store.resolve(ref, plugin_id='plugin', required_scopes=['write'], activity_scopes=['write'])


def test_revocation_erases_secret_and_invalidates_reference(tmp_path):
    store = CredentialStore(tmp_path / 'private')
    ref = put(store)
    store.revoke(ref)
    with pytest.raises(CredentialError): store.metadata(ref)
    assert 'private-token' not in (tmp_path / 'private' / (ref + '.json')).read_text()


def test_expiry_checked_at_resolution(tmp_path, monkeypatch):
    store = CredentialStore(tmp_path / 'private')
    ref = put(store, expires_at=time.time() + 10)
    monkeypatch.setattr('app.core.credentials.time.time', lambda: 99999999999)
    with pytest.raises(CredentialError, match='expired'): store.resolve(ref, plugin_id='wechat', required_scopes=['chat.read'], activity_scopes=['chat.read'])


def test_symlink_and_path_traversal_rejected(tmp_path):
    store = CredentialStore(tmp_path / 'private')
    with pytest.raises(CredentialError): store.metadata('../momo.yaml')
    external = tmp_path / 'external'; external.mkdir()
    (tmp_path / 'private').symlink_to(external, target_is_directory=True)
    with pytest.raises(CredentialError, match='storage'): put(store)
    assert list(external.iterdir()) == []


def test_world_readable_file_refused_without_secret_in_error(tmp_path):
    if os.name == 'nt': pytest.skip('POSIX file mode check')
    store = CredentialStore(tmp_path / 'private')
    ref = put(store)
    os.chmod(tmp_path / 'private' / (ref + '.json'), 0o644)
    with pytest.raises(CredentialError, match='unsafe') as error: store.metadata(ref)
    assert 'private-token' not in str(error.value)


def test_default_credentials_are_outside_export_and_life_directory():
    from app.core import state
    ref = put(credentials)
    assert not credentials._root().is_relative_to(state.DATA_DIR)
    files = archive.validate(archive.export_data())
    assert not any('credential' in name for name in files)
    assert all(b'private-token' not in value for value in files.values())
    assert credentials.metadata(ref)['pluginId'] == 'wechat'
