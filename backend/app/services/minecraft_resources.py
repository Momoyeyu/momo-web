"""Pinned, local-only Minecraft resource qualification and dedicated instance ownership."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import secrets
import tempfile
import time
import os
import subprocess
import threading
import signal
import sys

PINS = {'minecraft':'1.21.1','loader':'0.16.14','fabricApi':'0.116.4+1.21.1','java':21}


def qualify(root):
    root = Path(root).resolve(strict=True)
    manifest = json.loads((root / 'manifest.json').read_text())
    if manifest.get('schemaVersion') != 1 or manifest.get('pins') != PINS:
        raise ValueError('Minecraft resource pin mismatch')
    if manifest.get('platform') and manifest['platform'] != {'darwin':'osx','linux':'linux','win32':'windows'}.get(__import__('sys').platform):
        raise ValueError('Minecraft platform mismatch')
    if manifest.get('architecture') and manifest['architecture'] != __import__('platform').machine():
        raise ValueError('Minecraft architecture mismatch')
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
    candidates = [candidate] if candidate else [shutil.which('java')]
    if not candidate and __import__('sys').platform == 'darwin':
        try:
            home = subprocess.run(['/usr/libexec/java_home','-v','21'],capture_output=True,text=True,timeout=10,check=True).stdout.strip()
            candidates.insert(0,str(Path(home)/'bin/java'))
        except (OSError, subprocess.SubprocessError): pass
    for executable in candidates:
        if not executable: continue
        try:
            executable = str(Path(executable).resolve(strict=True))
            probe = subprocess.run([executable,'-version'],capture_output=True,text=True,timeout=10,check=True)
            if re.search(r'version "21\.',probe.stderr + probe.stdout): return executable
        except (OSError, subprocess.SubprocessError): continue
    raise ValueError('Java 21 is required')


class ManagedMinecraftInstance:
    """No inferred account, offline login, or token-bearing command lines."""
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.process = None
        self.lock = threading.RLock()
        self.token = None
        # The per-launch supervisor owns argument-file cleanup even after a
        # backend restart. Never unlink another launch's file during startup.

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
                # Closing the unique lifetime pipe revokes the supervisor lease.
                if self.process.stdin: self.process.stdin.close()
                try: self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    raise ValueError('Minecraft process stop could not be verified') from None
            self.process = None
            self.token = None
            return {'stopped':True}

    def launch(self, session=None, port=17643, cancelled=None):
        with self.lock:
            manifest = qualify(self.root)
            executable = java21()
            if not session or session.get('expiresAt',0) <= time.time()+60:
                raise ValueError('Microsoft public-client registration and validated session required')
            if self.process is not None and self.process.poll() is None:
                raise ValueError('Dedicated instance already running')
            if not manifest.get('platform') or not manifest.get('architecture'):
                raise ValueError('Platform-qualified Minecraft resources required')
            profile = session['profile']
            if not re.fullmatch('[0-9a-fA-F]{32}',profile['id']) or not re.fullmatch('[A-Za-z0-9_]{1,16}',profile['name']):
                raise ValueError('Invalid validated session profile')
            if not 1024 <= port <= 65535: raise ValueError('Invalid bridge port')
            self.token = secrets.token_urlsafe(32)
            args = ['-Xmx2G','-Dmomo.bridge.token='+self.token,'-Dmomo.bridge.port='+str(port),
                    '-Djava.library.path='+str(self.root/'natives'),'-cp',os.pathsep.join(str(self.root/p) for p in manifest['classpath']),
                    manifest['mainClass'],'--username',profile['name'],'--uuid',profile['id'],
                    '--accessToken',session['accessToken'],'--version','1.21.1','--gameDir',str(self.root),
                    '--assetsDir',str(self.root/'assets'),'--assetIndex',manifest['assetIndex'],'--userType','msa','--versionType','release']
            if __import__('sys').platform == 'darwin': args.insert(0,'-XstartOnFirstThread')
            if any('\n' in x or '\r' in x for x in args): raise ValueError('Invalid launch argument')
            fd, name = tempfile.mkstemp(prefix=f'.launch-{os.getpid()}-',dir=self.root)
            try:
                with os.fdopen(fd,'w') as out:
                    out.write('\n'.join('"'+x.replace('\\','\\\\').replace('"','\\"')+'"' for x in args))
                if cancelled and cancelled(): raise ValueError('Minecraft launch cancelled')
                self.process = subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--supervise',executable,name],cwd=self.root,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
            except Exception:
                Path(name).unlink(missing_ok=True)
                self.token = None
                raise
            # The JVM must read the argument file before it can be removed.
            process = self.process
            def cleanup():
                process.wait()
                Path(name).unlink(missing_ok=True)
            threading.Thread(target=cleanup,daemon=True).start()
            return {'running':True,'pid':self.process.pid}


def supervise(command, parent_stream, argument_file=None):
    """The lifetime pipe is an unforgeable parent lease, independent of PID reuse.

    Only this supervisor's direct child is signalled. EOF also covers SIGKILL or
    crashes of the Python backend; no process scan or stale PID killing occurs.
    """
    stopping = threading.Event()
    old_handlers = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        old_handlers[sig] = signal.signal(sig, lambda *_: stopping.set())
    def monitor():
        try:
            while parent_stream.read(1): pass
        finally: stopping.set()
    threading.Thread(target=monitor,daemon=True).start()
    child = None
    try:
        if stopping.is_set(): return
        child = subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)
        while child.poll() is None and not stopping.wait(.1): pass
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        if argument_file: Path(argument_file).unlink(missing_ok=True)
        for sig, handler in old_handlers.items(): signal.signal(sig, handler)


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] != '--supervise': raise SystemExit(2)
    supervise([sys.argv[2],'@'+sys.argv[3]],sys.stdin.buffer,sys.argv[3])
