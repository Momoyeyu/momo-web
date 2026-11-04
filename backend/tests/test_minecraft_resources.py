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

def test_launch_uses_private_argument_file_not_token_cli(tmp_path):
    import time
    from unittest.mock import Mock
    fixture(tmp_path)
    manifest=json.loads((tmp_path/'manifest.json').read_text()); manifest['assetIndex']='17'; manifest['platform']={'darwin':'osx','linux':'linux','win32':'windows'}[__import__('sys').platform]; manifest['architecture']=__import__('platform').machine()
    (tmp_path/'manifest.json').write_text(json.dumps(manifest))
    instance=ManagedMinecraftInstance(tmp_path)
    process=Mock(pid=123); process.poll.return_value=None
    session={'profile':{'id':'a'*32,'name':'Player'},'accessToken':'PRIVATE_ACCESS','expiresAt':time.time()+3600}
    with patch('app.services.minecraft_resources.java21',return_value='/qualified/java'), patch('subprocess.Popen',return_value=process) as spawn, patch('threading.Thread'):
        assert instance.launch(session)['running']
        argv=spawn.call_args.args[0]
        assert len(argv)==5 and argv[2]=='--supervise'
        assert 'PRIVATE_ACCESS' not in str(argv)
        argument_file=__import__('pathlib').Path(argv[4])
        assert argument_file.stat().st_mode & 0o777 == 0o600
        assert 'PRIVATE_ACCESS' in argument_file.read_text()
        argument_file.unlink()

def test_java21_prefers_macos_installed_version(tmp_path):
    from types import SimpleNamespace
    from app.services.minecraft_resources import java21
    java=tmp_path/'bin'/'java'; java.parent.mkdir(); java.write_text('fixture')
    responses=[SimpleNamespace(stdout=str(tmp_path)+'\n',stderr=''),SimpleNamespace(stdout='',stderr='openjdk version "21.0.7"')]
    with patch('sys.platform','darwin'),patch('shutil.which',return_value='/newer/java'),patch('subprocess.run',side_effect=responses):
        assert java21()==str(java.resolve())

def test_replacement_preserves_supervisor_owned_argument_file(tmp_path):
    stale=tmp_path/'.launch-999999-old'; stale.write_text('private')
    unrelated=tmp_path/'.launch-unrelated'; unrelated.write_text('other')
    with patch('os.kill',side_effect=ProcessLookupError): ManagedMinecraftInstance(tmp_path)
    assert stale.exists()  # A surviving supervisor owns removal.
    assert unrelated.exists()

def test_supervisor_stops_owned_child_when_backend_is_killed(tmp_path):
    import subprocess,sys,time,os
    from pathlib import Path
    module=Path(__import__('app.services.minecraft_resources',fromlist=['x']).__file__).resolve()
    ready=tmp_path/'ready'; stopped=tmp_path/'stopped'; argfile=tmp_path/'private-args';argfile.write_text('secret')
    child_code=("import signal,time,pathlib,sys; "
                f"signal.signal(signal.SIGTERM,lambda *_:(pathlib.Path({str(stopped)!r}).write_text('stopped'),sys.exit(0))); "
                f"pathlib.Path({str(ready)!r}).write_text('ready'); time.sleep(60)")
    supervisor_code=("import importlib.util,sys; "
        f"s=importlib.util.spec_from_file_location('owned',{str(module)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m); "
        f"m.supervise({[sys.executable,'-c',child_code]!r},sys.stdin.buffer,{str(argfile)!r})")
    parent_code=("import subprocess,sys,time; "
        f"p=subprocess.Popen({[sys.executable,'-c',supervisor_code]!r},stdin=subprocess.PIPE); time.sleep(60)")
    parent=subprocess.Popen([sys.executable,'-c',parent_code])
    try:
        deadline=time.monotonic()+5
        while not ready.exists() and time.monotonic()<deadline: time.sleep(.05)
        assert ready.exists()
        parent.kill();parent.wait(timeout=3)
        deadline=time.monotonic()+6
        while (not stopped.exists() or argfile.exists()) and time.monotonic()<deadline: time.sleep(.05)
        assert stopped.exists()
        assert not argfile.exists()
    finally:
        if parent.poll() is None: parent.kill();parent.wait(timeout=3)


def test_cancelled_launch_never_spawns(tmp_path):
    import time,platform,sys
    fixture(tmp_path)
    manifest=json.loads((tmp_path/'manifest.json').read_text())
    manifest.update(platform={'darwin':'osx','linux':'linux','win32':'windows'}[sys.platform],architecture=platform.machine(),assetIndex='17')
    (tmp_path/'manifest.json').write_text(json.dumps(manifest))
    instance=ManagedMinecraftInstance(tmp_path)
    session={'profile':{'id':'a'*32,'name':'Player'},'accessToken':'secret','expiresAt':time.time()+3600}
    with patch('app.services.minecraft_resources.java21',return_value='/java'),patch('subprocess.Popen') as spawn:
        with pytest.raises(ValueError,match='cancelled'): instance.launch(session,cancelled=lambda:True)
        spawn.assert_not_called()
    assert not list(tmp_path.glob('.launch-*'))
