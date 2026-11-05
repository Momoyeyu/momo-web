"""Install bundled QQ resources into this profile without importing account data."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from collections.abc import Callable


def _private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if path.is_symlink() or not path.is_dir() or info.st_uid != os.getuid():
        raise ValueError('Invalid QQ installation directory')
    path.chmod(0o700)


def _write_private(path: Path, content: bytes) -> None:
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='.install-')
    try:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def install_bundled_qq(bundle: Path, profile: Path, qualify: Callable[[Path, Path], None]) -> Path:
    profile = profile.resolve()
    _private_directory(profile)
    private = profile / 'qq-runtime'
    binding = profile / 'qq-runtime-binding.json'
    config_path = private / 'runtime-config.json'
    if binding.exists() or binding.is_symlink():
        info = binding.lstat()
        if binding.is_symlink() or not binding.is_file() or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 8192:
            raise ValueError('Invalid QQ startup binding')
        if json.loads(binding.read_bytes()).get('configPath') != str(config_path):
            return binding
    _private_directory(private)
    manifest_bytes = (bundle / 'manifest.json').read_bytes()
    version = hashlib.sha256(manifest_bytes).hexdigest()
    installed = private / version
    if installed.is_symlink():
        raise ValueError('Invalid QQ resource version')
    if not installed.exists():
        source = (bundle / 'resources').resolve(strict=True)
        for entry in source.rglob('*'):
            if entry.is_symlink() and not entry.resolve(strict=True).is_relative_to(source):
                raise ValueError('QQ resource link escapes its closure')
        staging = Path(tempfile.mkdtemp(dir=private, prefix='.install-'))
        try:
            resources = staging / 'resources'
            shutil.copytree(source, resources, symlinks=True)
            resources.chmod(0o700)
            _write_private(staging / 'manifest.json', manifest_bytes)
            qualify(resources, staging / 'manifest.json')
            staging.rename(installed)
        finally:
            if staging.exists(): shutil.rmtree(staging)
    for name in ('data', 'runtime-control'):
        _private_directory(private / name)
    canary = private / 'barrier-canary'
    _write_private(canary, b'momo-private-barrier-check\n')
    config = dict(privateRoot=str(private), resourceRoot=str(installed / 'resources'),
                  manifestPath=str(installed / 'manifest.json'), dataRoot=str(private / 'data'),
                  controlRoot=str(private / 'runtime-control'), canaryPath=str(canary))
    _write_private(config_path, json.dumps(config).encode())
    _write_private(binding, json.dumps({'configPath': str(config_path)}).encode())
    return binding


def prepare_installed_qq(resources: Path, profile: Path) -> None:
    bundle = resources / 'qq'
    if not bundle.is_dir():
        return
    node = resources / 'node/bin/node'
    qualifier = resources / 'plugin-host/src/qq-resources.mjs'
    script = """import {readFileSync} from 'node:fs';
const {qualifyQQResources}=await import(process.argv[1]);
await qualifyQQResources({root:process.argv[2],manifest:JSON.parse(readFileSync(process.argv[3],'utf8'))});"""
    def qualify(root: Path, manifest: Path) -> None:
        result = subprocess.run([str(node), '--input-type=module', '-e', script,
                                 qualifier.as_uri(), str(root), str(manifest)],
                                capture_output=True, timeout=180, check=False)
        if result.returncode:
            raise ValueError('Bundled QQ resource qualification failed')
    install_bundled_qq(bundle, profile, qualify)
