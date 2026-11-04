"""Private owned-account and dedicated-instance facade; never return session tokens."""
import json
import os
import time
import hashlib
import httpx
from pathlib import Path
import threading
import uuid
from ..core import state
from .minecraft import minecraft
from .minecraft_auth import MinecraftAuth
from .minecraft_resources import ManagedMinecraftInstance, qualify

_lock = threading.RLock()
_auth = None
_instance = None
_starting = None

def instance():
    global _instance
    root = (state.DATA_DIR / 'minecraft-instance').resolve()
    if _instance is None or _instance.root != root:
        _instance = ManagedMinecraftInstance(root)
    return _instance

def auth():
    global _auth
    root = state.DATA_DIR / 'minecraft-private'
    if _auth is None or _auth.path != root / 'credentials.json':
        config = json.loads((root / 'client.json').read_text())
        _auth = MinecraftAuth(config['clientId'], root / 'credentials.json')
    return _auth

def default_resources():
    if os.environ.get('MOMO_MINECRAFT_RESOURCES'):
        return Path(os.environ['MOMO_MINECRAFT_RESOURCES'])
    return Path(os.environ.get('MOMO_RESOURCES_DIR', str(Path(__file__).resolve().parents[2] / 'resources'))) / 'minecraft'


def manifest_stamp(root):
    return hashlib.sha256((root / 'manifest.json').read_bytes()).hexdigest()


def status():
    inst = instance()
    prepared = False
    try: prepared = (inst.root / '.momo-qualified').read_text() == manifest_stamp(inst.root)
    except (ValueError, OSError, KeyError): pass
    result = {'starting':_starting is not None,'prepared':prepared,'running':inst.status()['running'],'authenticated':False,'remembered':False,'loginAvailable':True}
    try:
        account = auth()
        remembered = account.remembered()
        if remembered:
            result.update(remembered=True,profile=remembered)
        session = account.cached
        if session and session['expiresAt'] > time.time()+60:
            result.update(authenticated=True,profile=session['profile'])
    except (ValueError, OSError, KeyError): pass
    return result

def begin(client_id):
    global _auth
    with _lock:
        root = state.DATA_DIR / 'minecraft-private'
        candidate = MinecraftAuth(client_id, root / 'credentials.json')
        result = candidate.begin()
        root.mkdir(parents=True,exist_ok=True,mode=0o700)
        (root / 'client.json').write_text(json.dumps({'clientId':candidate.client_id}))
        _auth = candidate
        return result

def poll():
    with _lock: return auth().poll()

def stop():
    # Signal without waiting for identity-provider I/O, resource hashing, or ping.
    with _lock:
        pending = _starting
        if pending is not None:
            pending.set()
    def reclaim():
        try:
            minecraft.stop()
        finally:
            result = instance().stop()
        return result
    if pending is not None:
        return {'stopped':False, 'stopping':True}
    return reclaim()


def logout():
    with _lock:
        if _starting is not None:
            _starting.logout = True
        try:
            stop()
        finally:
            auth().logout()
        return {'authenticated':False}

def prepare(resources=None):
    with _lock:
        inst = instance()
        inst.prepare(resources or default_resources())
        (inst.root / '.momo-qualified').write_text(manifest_stamp(inst.root))
        return status()

def wait_ready(inst, port=17643, timeout=60, cancelled=None):
    deadline = time.monotonic() + timeout
    with httpx.Client(timeout=1, trust_env=False) as client:
        while time.monotonic() < deadline:
            if cancelled is not None and cancelled():
                raise ValueError('Minecraft startup cancelled')
            if not inst.status()['running']:
                raise ValueError('Minecraft exited before bridge readiness')
            try:
                response = client.post(f'http://127.0.0.1:{port}/command',
                    headers={'Authorization':'Bearer '+inst.token}, json={'type':'ping'})
                if response.status_code == 200 and response.json().get('ready') is True:
                    return
            except (httpx.HTTPError, ValueError):
                pass
            time.sleep(.2)
    raise ValueError('Minecraft bridge readiness timed out')


def start(server, world, permissions, client, lease):
    global _starting
    if '/' in server or any(c.isspace() for c in server) or not server:
        raise ValueError('Invalid server address')
    if not world or '/' in world or ':' not in world:
        raise ValueError('Use a dimension identifier such as minecraft:overworld')
    if 'game.observe' not in permissions: raise ValueError('Observation permission required')
    with _lock:
        if _starting is not None: raise ValueError('Minecraft startup already pending')
        account, inst = auth(), instance()
        cancel = threading.Event()
        _starting = cancel
    def current():
        if cancel.is_set(): raise ValueError('Minecraft startup cancelled')
        minecraft.gate(client, lease)
    launched = False
    try:
        current()
        session = account.session()
        current()
        inst.launch(session, cancelled=cancel.is_set)
        launched = True
        current()
        wait_ready(inst, cancelled=cancel.is_set)
        current()
        minecraft.connect(17643,inst.token,server+'/'+world,str(uuid.UUID(session['profile']['id'])),permissions,client,lease)
        current()
        return {**status(),'joinRequired':True,'starting':False}
    except Exception:
        if getattr(cancel, 'logout', False):
            account.logout()
        if launched:
            try:
                minecraft.stop()
            finally:
                inst.stop()
        raise
    finally:
        with _lock:
            if _starting is cancel: _starting = None


def shutdown():
    """Only reclaim the owned JVM; host shutdown handles execution revocation."""
    if _starting is not None:
        _starting.set()
    if _instance is not None:
        _instance.stop()
