import json
from pathlib import Path
import pytest
from app.core.qq_install import install_bundled_qq


def test_install_is_private_atomic_and_preserves_profile(tmp_path):
    bundle = tmp_path / 'bundle'
    resources = bundle / 'resources'
    resources.mkdir(parents=True)
    (resources / 'worker.cjs').write_text('worker')
    (bundle / 'manifest.json').write_text('{"schemaVersion":1}')
    profile = tmp_path / 'profile'
    checked = []
    qualify = lambda root, manifest: checked.append(root)
    binding = install_bundled_qq(bundle, profile, qualify)
    config = json.loads(Path(json.loads(binding.read_text())['configPath']).read_text())
    root = Path(config['privateRoot'])
    assert root.is_relative_to(profile)
    assert Path(config['resourceRoot'], 'worker.cjs').read_text() == 'worker'
    assert binding.stat().st_mode & 0o777 == 0o600
    assert root.stat().st_mode & 0o777 == 0o700
    session = Path(config['dataRoot']) / 'session'
    session.write_text('keep')
    install_bundled_qq(bundle, profile, qualify)
    assert len(checked) == 1
    assert session.read_text() == 'keep'
    (bundle / 'manifest.json').write_text('{"schemaVersion":2}')
    install_bundled_qq(bundle, profile, qualify)
    assert session.read_text() == 'keep'
    assert len(checked) == 2


def test_failed_qualification_never_publishes_binding_and_can_retry(tmp_path):
    bundle = tmp_path / 'bundle'
    (bundle / 'resources').mkdir(parents=True)
    (bundle / 'manifest.json').write_text('{}')
    def reject(*args): raise ValueError('invalid closure')
    with pytest.raises(ValueError): install_bundled_qq(bundle, tmp_path / 'profile', reject)
    assert not (tmp_path / 'profile/qq-runtime-binding.json').exists()
    assert install_bundled_qq(bundle, tmp_path / 'profile', lambda *args: None).is_file()


def test_external_resource_symlink_rejected(tmp_path):
    bundle = tmp_path / 'bundle'
    (bundle / 'resources').mkdir(parents=True)
    (bundle / 'manifest.json').write_text('{}')
    outside = tmp_path / 'outside'
    outside.write_text('private')
    (bundle / 'resources/escape').symlink_to(outside)
    with pytest.raises(ValueError): install_bundled_qq(bundle, tmp_path / 'profile', lambda *args: None)
