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
 monkeypatch.setattr(bridge,'inspect',lambda *a:({'port':1234,'token':'x'*40},{'world':'local/overworld','account':'a'}))
 with pytest.raises(MinecraftError):bridge.attach('1','other','a',['game.observe'],'c','l')
 monkeypatch.setattr(bridge.minecraft,'connect',lambda *a:a)
 assert bridge.attach('1','local/overworld','a',['game.observe'],'c','l')[0]==1234

def test_install_never_overwrites(tmp_path,monkeypatch):
 mod=tmp_path/'momo.jar';mod.write_bytes(b'jar')
 instance=tmp_path/'game';instance.mkdir()
 monkeypatch.setattr(bridge,'MOD',mod)
 assert bridge.install(str(instance))['installed']
 (instance/'mods/momo.jar').write_bytes(b'other')
 with pytest.raises(MinecraftError):bridge.install(str(instance))
