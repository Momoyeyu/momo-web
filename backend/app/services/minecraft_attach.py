"""Attach to the user's explicitly selected running Fabric client; never launch/login."""
import json, os, stat, re, shutil
from pathlib import Path
import httpx
from .minecraft import minecraft, MinecraftError
DIRECTORY = Path.home()/'.momo'/'minecraft-bridge'
MOD = Path(__file__).resolve().parents[3]/'plugin-host/minecraft-fabric/build/libs/momo-fabric-companion-0.1.0.jar'
def read(session):
    if not re.fullmatch(r'[0-9]+',session): raise MinecraftError('Invalid session')
    try:
        fd=os.open(DIRECTORY/(session+'.json'),os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd) as stream:
            info=os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_size>4096: raise ValueError()
            value=json.load(stream)
        if value['pid']!=int(session) or not 1024<=value['port']<=65535 or not 32<=len(value['token'])<=512: raise ValueError()
        os.kill(value['pid'],0)
        return value
    except (OSError,ValueError,KeyError,TypeError): raise MinecraftError('Game session unavailable') from None

def inspect(session):
    value=read(session)
    try:
        with httpx.Client(timeout=2,trust_env=False) as client:
            response=client.post(f"http://127.0.0.1:{value['port']}/command",headers={'Authorization':'Bearer '+value['token']},json={'type':'ping'})
            response.raise_for_status();data=response.json()
        if data.get('protocol')!=1: raise ValueError()
        return value,data
    except (httpx.HTTPError,ValueError): raise MinecraftError('Game bridge unavailable') from None

def sessions():
    rows=[]
    for path in list(DIRECTORY.glob('*.json'))[:16]:
        try:
            value,data=inspect(path.stem)
            rows.append({'id':path.stem,'pid':value['pid'],'ready':bool(data.get('world')),'world':data.get('world'),'account':data.get('account'),'playerName':data.get('playerName')})
        except MinecraftError: continue
    return {'sessions':rows}

def attach(session,world,account,permissions,client,lease):
    minecraft.gate(client,lease)
    value,data=inspect(session)
    if not world or not account or data.get('world')!=world or data.get('account')!=account or 'game.observe' not in permissions: raise MinecraftError('Selected game identity changed')
    return minecraft.connect(value['port'],value['token'],world,account,permissions,client,lease)

def install(instance_path):
    root=Path(instance_path).expanduser()
    if not root.is_dir() or root.is_symlink() or any(p.is_symlink() for p in root.parents): raise MinecraftError('Select an existing game instance')
    if not MOD.is_file(): raise MinecraftError('Companion mod resource unavailable')
    dest=root/'mods'
    if dest.is_symlink(): raise MinecraftError('Symlink mod directory forbidden')
    dest.mkdir(exist_ok=True)
    target=dest/MOD.name
    try:
        with target.open('xb') as out: out.write(MOD.read_bytes())
    except FileExistsError:
        if target.is_symlink() or target.read_bytes()!=MOD.read_bytes(): raise MinecraftError('Existing mod differs; remove explicitly before installing')
    return {'installed':True,'restartRequired':True}
