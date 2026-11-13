#!/usr/bin/env python3
"""Build-time only: verify the pinned Fabric dependency before any bytecode loads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from urllib.request import Request, urlopen
import zipfile

ROOT=Path(__file__).resolve().parents[1]
LOCK=Path(__file__).with_name('minecraft-resources.json')

def verify(path, lock):
    path=Path(path)
    if path.is_symlink(): raise ValueError('Dependency must be a regular file')
    fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    with os.fdopen(fd,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>lock['maxBytes']:
            raise ValueError('Dependency must be a bounded regular file')
        digest=hashlib.sha256()
        for chunk in iter(lambda: stream.read(65536), b''): digest.update(chunk)
        if digest.hexdigest()!=lock['sha256']:
            raise ValueError('Dependency checksum mismatch')
        stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            entry=archive.getinfo('fabric.mod.json')
            if entry.file_size>65536: raise ValueError('Oversized Fabric metadata')
            metadata=json.loads(archive.read(entry))
    if metadata.get('id')!=lock['modId'] or metadata.get('version')!=lock['version']:
        raise ValueError('Dependency identity mismatch')
    versions=metadata.get('depends',{}).get('minecraft',[])
    if isinstance(versions,str): versions=[versions]
    if lock['minecraft'] not in versions: raise ValueError('Unsupported Minecraft version')
    if metadata.get('license')!=lock['license']: raise ValueError('Dependency license mismatch')
    return metadata

def prepare(destination, *, source=None, offline=False):
    lock=json.loads(LOCK.read_text())['baritone']
    destination=Path(destination)
    destination.mkdir(parents=True,exist_ok=True)
    if destination.is_symlink() or any(p.is_symlink() for p in destination.parents):
        raise ValueError('Symlink dependency directory forbidden')
    target=destination/lock['file']
    if target.exists() or target.is_symlink():
        verify(target,lock)
        return target
    if source is None and offline: raise ValueError('Verified dependency absent in offline mode')
    with tempfile.NamedTemporaryFile(dir=destination,suffix='.download',delete=False) as stream:
        temporary=Path(stream.name)
        try:
            if source is not None:
                verify(source,lock)
                with Path(source).open('rb') as incoming: shutil.copyfileobj(incoming,stream)
            else:
                with urlopen(Request(lock['url'],headers={'User-Agent':'momo-build'}),timeout=60) as incoming:
                    data=incoming.read(lock['maxBytes']+1)
                    if len(data)>lock['maxBytes']: raise ValueError('Dependency download exceeds limit')
                    stream.write(data)
            stream.flush()
            verify(temporary,lock)
            os.replace(temporary,target)
        finally:
            temporary.unlink(missing_ok=True)
    return target

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination',type=Path,default=ROOT/'plugin-host/minecraft-fabric/deps')
    parser.add_argument('--source',type=Path)
    parser.add_argument('--offline',action='store_true')
    args=parser.parse_args()
    print(prepare(args.destination,source=args.source,offline=args.offline))

if __name__=='__main__': main()
