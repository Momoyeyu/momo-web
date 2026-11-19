import json,os
import pytest
from app.services import minecraft_attach as bridge
from app.services.minecraft import MinecraftError

def test_private_discovery_and_invalid_paths(tmp_path,monkeypatch):
 monkeypatch.setattr(bridge,'DIRECTORY',tmp_path)
 p=tmp_path/f'{os.getpid()}.json'
 p.write_text(json.dumps({'pid':os.getpid(),'port':17649,'token':'x'*40}));p.chmod(0o600)
 assert bridge.read(str(os.getpid()))['port']==17649
 p.chmod(0o644)
 with pytest.raises(MinecraftError):bridge.read(str(os.getpid()))
 with pytest.raises(MinecraftError):bridge.read('../escape')

def test_attach_rechecks_identity(monkeypatch):
 monkeypatch.setattr(bridge.minecraft,'gate',lambda *a:None)
 monkeypatch.setattr(bridge,'inspect',lambda *a:({'pid':42,'port':1234,'token':'x'*40},{'world':'local/overworld','account':'a'}))
 with pytest.raises(MinecraftError):bridge.attach('1','other','a',['game.observe'],'c','l')
 monkeypatch.setattr(bridge.minecraft,'connect',lambda *a:a)
 args=bridge.attach('1','local/overworld','a',['game.observe'],'c','l')
 assert args[0]==1234 and args[-1]==42

def test_install_never_overwrites(tmp_path,monkeypatch):
 mod=tmp_path/'momo.jar';mod.write_bytes(b'jar')
 instance=tmp_path/'game';instance.mkdir()
 monkeypatch.setattr(bridge,'mod_resource',lambda:mod)
 monkeypatch.setattr(bridge,'require_fabric_dependency',lambda *_:None)
 assert bridge.install(str(instance))['installed']
 (instance/'mods/momo.jar').write_bytes(b'other')
 with pytest.raises(MinecraftError):bridge.install(str(instance))

def test_install_updates_only_recognized_momo_mod_atomically(tmp_path,monkeypatch):
 import zipfile
 def jar(path,version):
  with zipfile.ZipFile(path,'w') as archive:
   archive.writestr('fabric.mod.json',json.dumps({'id':'momo_companion','version':version,'entrypoints':{'client':['dev.momo.CompanionClient']}}))
 mod=tmp_path/'momo.jar';jar(mod,'next')
 instance=tmp_path/'game';(instance/'mods').mkdir(parents=True)
 target=instance/'mods/momo.jar';jar(target,'old')
 unrelated=instance/'mods/player-mod.jar';unrelated.write_bytes(b'keep')
 monkeypatch.setattr(bridge,'mod_resource',lambda:mod)
 monkeypatch.setattr(bridge,'require_fabric_dependency',lambda *_:None)
 result=bridge.install(str(instance))
 assert result['installed'] and result['updated'] and result['restartRequired']
 assert target.read_bytes()==mod.read_bytes() and unrelated.read_bytes()==b'keep'
 assert sorted(p.name for p in target.parent.iterdir())==['momo.jar','player-mod.jar']

def test_install_refuses_symlink_even_when_contents_match(tmp_path,monkeypatch):
 mod=tmp_path/'momo.jar';mod.write_bytes(b'jar')
 instance=tmp_path/'game';(instance/'mods').mkdir(parents=True)
 (instance/'mods/momo.jar').symlink_to(mod)
 monkeypatch.setattr(bridge,'mod_resource',lambda:mod)
 monkeypatch.setattr(bridge,'require_fabric_dependency',lambda *_:None)
 with pytest.raises(MinecraftError):bridge.install(str(instance))

def test_companion_comes_from_enabled_installation(tmp_path,monkeypatch):
 from app.services import mods
 monkeypatch.setattr(mods,'integration_root',lambda _:None)
 with pytest.raises(MinecraftError):bridge.mod_resource()
 monkeypatch.setattr(mods,'integration_root',lambda _:tmp_path)
 assert bridge.mod_resource()==tmp_path/'resources/minecraft/momo-fabric-companion-0.1.0.jar'

def test_discovery_limit_counts_live_sessions_instead_of_old_client_files(tmp_path,monkeypatch):
 monkeypatch.setattr(bridge,'DIRECTORY',tmp_path)
 for i in range(24):(tmp_path/f'{i}.json').write_text('{}')
 def inspect(session):
  if session!='23':raise MinecraftError('Game session unavailable')
  return {'pid':23},{'world':'w','account':'p'}
 monkeypatch.setattr(bridge,'inspect',inspect)
 assert bridge.sessions()['sessions'][0]['pid']==23

def test_companion_requires_verified_external_dependency(tmp_path):
 import hashlib
 cap=tmp_path/'momo.jar'
 digest=hashlib.sha256(b'pinned').hexdigest()
 (tmp_path/'dependency.json').write_text(json.dumps({'baritone':{'file':'baritone.jar','maxBytes':10,'sha256':digest}}))
 (tmp_path/'baritone.jar').write_bytes(b'wrong')
 with pytest.raises(MinecraftError,match='baritone.jar'):bridge.require_fabric_dependency(cap,tmp_path)
 (tmp_path/'renamed.jar').write_bytes(b'pinned')
 bridge.require_fabric_dependency(cap,tmp_path)
