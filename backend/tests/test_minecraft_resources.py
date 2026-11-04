import hashlib
import json
from unittest.mock import patch
import pytest
from app.services.minecraft_resources import qualify, PINS, ManagedMinecraftInstance

def fixture(root):
    name = 'mods/momo-fabric-companion-0.1.0.jar'
    (root/'mods').mkdir()
    (root/name).write_bytes(b'isolated-fixture')
    manifest = {'schemaVersion':1,'pins':PINS,'mainClass':'net.fabricmc.loader.impl.launch.knot.KnotClient','classpath':[name], 'files':[{'path':name,'sha256':hashlib.sha256(b'isolated-fixture').hexdigest()}]}
    (root/'manifest.json').write_text(json.dumps(manifest))
    return name

def test_prepare_isolated_and_reject_tamper(tmp_path):
    source=tmp_path/'source'; source.mkdir(); name=fixture(source)
    instance=ManagedMinecraftInstance(tmp_path/'dedicated')
    assert instance.prepare(source)['loginAvailable'] is False
    with pytest.raises(ValueError,match='overwrite'): instance.prepare(source)
    (source/name).write_bytes(b'tampered')
    with pytest.raises(ValueError,match='hash'): qualify(source)

def test_no_offline_fallback_or_process_on_missing_login(tmp_path):
    fixture(tmp_path)
    instance=ManagedMinecraftInstance(tmp_path)
    with patch('app.services.minecraft_resources.java21'), patch('subprocess.Popen') as spawn:
        with pytest.raises(ValueError,match='registration'): instance.launch()
        spawn.assert_not_called()
