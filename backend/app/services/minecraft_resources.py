"""Pinned, local-only Minecraft resource qualification and dedicated instance ownership."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import threading

PINS = {'minecraft':'1.21.1','loader':'0.16.14','fabricApi':'0.116.4+1.21.1','java':21}


def qualify(root):
    root = Path(root).resolve(strict=True)
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest.get('schemaVersion') != 1 or manifest.get('pins') != PINS:
        raise ValueError('Minecraft resource pin mismatch')
    entries = manifest.get('files', [])
    if not entries or len(entries) > 100000:
        raise ValueError('Minecraft resource closure missing')
    paths = set()
    for entry in entries:
        name = entry['path']
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or str(path) != name or '\\' in name or name in paths:
            raise ValueError('Invalid Minecraft resource path')
        paths.add(name)
        target = root / name
        if any(p.is_symlink() for p in [target, *target.parents] if p != root.parent):
            raise ValueError('Resource symlinks forbidden')
        if not target.is_file() or not re.fullmatch('[a-f0-9]{64}',entry['sha256']) or hashlib.sha256(target.read_bytes()).hexdigest() != entry['sha256']:
            raise ValueError('Minecraft resource hash mismatch')
    for required in manifest.get('classpath', []):
        if required not in paths or not required.endswith('.jar'): raise ValueError('Unqualified classpath')
    if not manifest.get('classpath') or manifest.get('mainClass') != 'net.fabricmc.loader.impl.launch.knot.KnotClient':
        raise ValueError('Fabric launch closure missing')
    if 'mods/momo-fabric-companion-0.1.0.jar' not in paths:
        raise ValueError('Companion mod missing')
    return manifest


def java21(candidate=None):
    executable = candidate or shutil.which('java')
    if not executable: raise ValueError('Java 21 is required')
    executable = str(Path(executable).resolve(strict=True))
    probe = subprocess.run([executable,'-version'],capture_output=True,text=True,timeout=10,check=True)
    if not re.search(r'version "21\.',probe.stderr + probe.stdout): raise ValueError('Java 21 is required')
    return executable


class ManagedMinecraftInstance:
    """No inferred account, offline login, or token-bearing command lines."""
    def __init__(self, root):
        self.root = Path(root)
        self.process = None
        self.lock = threading.RLock()
        self.token = None

    def status(self):
        return {'running':self.process is not None and self.process.poll() is None,
                'loginAvailable':False, 'reason':'Microsoft public-client registration and session provider required'}

    def prepare(self, resources):
        with self.lock:
            if self.root.exists(): raise ValueError('Dedicated instance already exists; will not overwrite')
            manifest = qualify(resources)
            self.root.mkdir(parents=True, mode=0o700)
            try:
                for entry in manifest['files']:
                    target = self.root / entry['path']
                    target.parent.mkdir(parents=True,exist_ok=True)
                    shutil.copyfile(Path(resources)/entry['path'],target)
                    target.chmod(0o600)
                (self.root/'manifest.json').write_text(json.dumps(manifest))
                qualify(self.root)
            except Exception:
                shutil.rmtree(self.root)
                raise
            return self.status()

    def stop(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try: self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
            self.token = None
            return {'stopped':True}

    def launch(self):
        # Deliberately unavailable until an owned OAuth registration and verified
        # Java entitlement/profile supply a session through a private launch file.
        qualify(self.root)
        java21()
        raise ValueError(self.status()['reason'])
