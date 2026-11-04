#!/usr/bin/env python3
"""Build-time official metadata resolver. Never invoked by the game runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import sys
import urllib.request
import urllib.parse
import zipfile
import time
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor

HOSTS = {'piston-meta.mojang.com','piston-data.mojang.com','launchermeta.mojang.com','launcher.mojang.com','libraries.minecraft.net','resources.download.minecraft.net','meta.fabricmc.net','maven.fabricmc.net'}
def fetch(url):
    if urllib.parse.urlparse(url).scheme != 'https' or urllib.parse.urlparse(url).hostname not in HOSTS: raise ValueError('Nonofficial resource origin')
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url,timeout=30) as response:
                if urllib.parse.urlparse(response.url).hostname not in HOSTS: raise ValueError('Unexpected redirect')
                return response.read()
        except (OSError, TimeoutError):
            if attempt == 3: raise
            time.sleep(min(2 ** attempt, 4))

def data(url): return json.loads(fetch(url))
def prepare(destination, mod, cache=None):
    cache = cache or destination.parent / (destination.name+'.cache')
    cache.mkdir(parents=True,exist_ok=True,mode=0o700)
    if destination.exists(): raise ValueError('Destination exists')
    destination.mkdir(parents=True,mode=0o700)
    files={}; classpath=[]
    def save(name, payload, source):
        path=Path(name)
        if path.is_absolute() or '..' in path.parts: raise ValueError('Invalid artifact path')
        target=destination/path; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(payload)
        files[name]={'path':name,'sha256':hashlib.sha256(payload).hexdigest(),'source':source}
    def download(name,url,sha1):
        if urllib.parse.urlparse(url).scheme != 'https' or urllib.parse.urlparse(url).hostname not in HOSTS: raise ValueError('Nonofficial resource origin')
        if not re.fullmatch('[a-f0-9]{40}',sha1): raise ValueError('Invalid official digest')
        cached=cache/sha1
        raw=cached.read_bytes() if cached.is_file() else None
        if raw is None or hashlib.sha1(raw).hexdigest()!=sha1:
            raw=fetch(url)
            if hashlib.sha1(raw).hexdigest()!=sha1: raise ValueError('Official checksum mismatch: '+url)
            fd,temp=tempfile.mkstemp(dir=cache)
            with os.fdopen(fd,'wb') as out: out.write(raw)
            os.replace(temp,cached)
        save(name,raw,url)
    try:
        versions=data('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
        pinned=next(v for v in versions['versions'] if v['id']=='1.21.1')
        raw=fetch(pinned['url'])
        if hashlib.sha1(raw).hexdigest()!=pinned['sha1']: raise ValueError('Version metadata mismatch')
        version=json.loads(raw)
        fabric=data('https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.14/profile/json')
        osname={'darwin':'osx','linux':'linux','win32':'windows'}[sys.platform]
        def allowed(lib):
            result=not lib.get('rules')
            for rule in lib.get('rules',[]):
                spec=rule.get('os',{})
                if rule.get('features'): continue
                if spec.get('name',osname)!=osname: continue
                if spec.get('arch') and spec['arch']!=platform.machine(): continue
                if spec.get('version'): raise ValueError('Unsupported OS rule; inspect before release')
                result=rule['action']=='allow'
            return result
        client=version['downloads']['client']; download('client.jar',client['url'],client['sha1']); classpath.append('client.jar')
        for lib in version['libraries']:
            if not allowed(lib): continue
            artifact=lib.get('downloads',{}).get('artifact')
            if artifact:
                name='libraries/'+artifact['path']; download(name,artifact['url'],artifact['sha1']); classpath.append(name)
            classifier=lib.get('natives',{}).get(osname)
            if classifier:
                artifact=lib['downloads']['classifiers'][classifier.replace('${arch}','64')]
                name='libraries/'+artifact['path']; download(name,artifact['url'],artifact['sha1'])
                with zipfile.ZipFile(destination/name) as archive:
                    for member in archive.infolist():
                        if member.is_dir() or member.filename.startswith('META-INF/'): continue
                        save('natives/'+member.filename,archive.read(member),artifact['url'])
        for lib in fabric['libraries']:
            group,name,ver=lib['name'].split(':')
            relative=group.replace('.','/')+'/'+name+'/'+ver+'/'+name+'-'+ver+'.jar'
            url=lib.get('url','https://maven.fabricmc.net/')+relative
            sha=fetch(url+'.sha1').decode().strip().split()[0]
            download('libraries/'+relative,url,sha); classpath.append('libraries/'+relative)
        index=version['assetIndex']; raw=fetch(index['url'])
        if hashlib.sha1(raw).hexdigest()!=index['sha1']: raise ValueError('Asset index mismatch')
        save('assets/indexes/'+index['id']+'.json',raw,index['url'])
        asset_hashes=sorted({entry['hash'] for entry in json.loads(raw)['objects'].values()})
        def asset(sha):
            download('assets/objects/'+sha[:2]+'/'+sha,'https://resources.download.minecraft.net/'+sha[:2]+'/'+sha,sha)
        print('Preparing',len(asset_hashes),'verified assets with 6 workers',flush=True)
        with ThreadPoolExecutor(max_workers=6) as pool:
            for completed,_ in enumerate(pool.map(asset,asset_hashes)):
                if completed % 100 == 0: print('Assets',completed,'/',len(asset_hashes),flush=True)
        api='https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.116.4+1.21.1/fabric-api-0.116.4+1.21.1.jar'
        download('mods/fabric-api-0.116.4+1.21.1.jar',api,fetch(api+'.sha1').decode().strip().split()[0])
        save('mods/momo-fabric-companion-0.1.0.jar',mod.read_bytes(),'original-local-build')
        manifest={'schemaVersion':1,'pins':{'minecraft':'1.21.1','loader':'0.16.14','fabricApi':'0.116.4+1.21.1','java':21},'platform':osname,'architecture':platform.machine(),'mainClass':fabric['mainClass'],'assetIndex':index['id'],'classpath':classpath,'files':[files[key] for key in sorted(files)]}
        (destination/'manifest.json').write_text(json.dumps(manifest,indent=2))
    except Exception:
        shutil.rmtree(destination)
        raise
if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--destination',type=Path,required=True); parser.add_argument('--mod',type=Path,required=True); parser.add_argument('--cache',type=Path)
    args=parser.parse_args(); prepare(args.destination.resolve(),args.mod.resolve(strict=True),args.cache.resolve() if args.cache else None)
