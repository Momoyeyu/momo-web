"""Bounded, private per-account attachment library. Models see opaque IDs only."""
from __future__ import annotations
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import threading
import uuid
from ..core import state
from .social import social, SocialError

MAX_BYTES=8*1024*1024
MAX_TOTAL=64*1024*1024
MIMES={'image/png','image/jpeg','image/webp','audio/wav','audio/x-wav','audio/mpeg','audio/ogg','video/mp4','application/pdf','text/plain','application/octet-stream'}
lock=threading.RLock()

def binding():
    with social.lock:
        account=social._account('qq')
        return {key:account.get(key) for key in ('accountId','expectedSelfId','policyRevision')}

def _root(expected=None):
    account=social._account('qq')
    if expected is not None and any(account.get(key)!=expected.get(key) for key in ('accountId','expectedSelfId','policyRevision')):
        raise SocialError('QQ attachment authorization changed')
    identity=account.get('expectedSelfId')
    if not identity:
        raise SocialError('Log in to a QQ account first')
    key=hashlib.sha256((account['accountId']+':'+identity).encode()).hexdigest()
    parent=state.DATA_DIR/'social-media'
    root=parent/key
    if parent.is_symlink() or root.is_symlink():raise SocialError('Invalid media directory')
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if parent.is_symlink() or root.is_symlink():raise SocialError('Invalid media directory')
    return root

def _id(value):
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{32}',value):
        raise SocialError('Invalid media ID')
    return value

def _read(path,limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,'rb') as source:
        info=os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size>limit:
            raise SocialError('Invalid media resource')
        return source.read(limit+1)

def _metadata(root,media_id):
    item=json.loads(_read(root/(media_id+'.json'),4096))
    if item.get('mediaId')!=media_id:
        raise SocialError('Invalid media resource')
    return item

def listing(audience='owner'):
    with social.lock, lock:
        root=_root();items=[]
        for entry in root.glob('*.json'):
            if not re.fullmatch('[a-f0-9]{32}',entry.stem):continue
            try:
                row=_metadata(root,entry.stem)
                if row.get('audience')==audience:
                    items.append({k:row[k] for k in ('mediaId','name','mime','size')})
            except (OSError,ValueError,SocialError):continue
        return items[:200]

def store(name,mime,data,*,audience='owner',expected=None):
    name=str(name or '')
    if (not name or len(name)>160 or name in {'.','..'} or any(ord(c)<32 or c in '/\\' for c in name)
        or Path(name).suffix.lower() in {'.exe','.dll','.app','.sh','.bat','.cmd','.ps1','.js','.html','.svg'}):
        raise SocialError('Use a plain attachment filename')
    if mime not in MIMES or not isinstance(data,bytes) or not 0<len(data)<=MAX_BYTES:
        raise SocialError('Unsupported attachment or size exceeds 8 MiB')
    with social.lock, lock:
        root=_root(expected)
        sizes=[f.lstat().st_size for f in root.glob('*.bin')]
        if len(sizes)>=200 or sum(sizes)+len(data)>MAX_TOTAL:
            raise SocialError('Attachment library is full; remove files first')
        media_id=uuid.uuid4().hex
        item={'mediaId':media_id,'name':name,'mime':mime,'size':len(data),'audience':audience}
        paths=[]
        try:
            for suffix,content in [('bin',data),('json',json.dumps(item,ensure_ascii=False).encode())]:
                path=root/(media_id+'.'+suffix)
                fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600);paths.append(path)
                with os.fdopen(fd,'wb') as out:out.write(content)
        except Exception:
            for path in paths:path.unlink(missing_ok=True)
            raise
    return {k:item[k] for k in ('mediaId','name','mime','size')}

def payload(media_id,*,audience='owner',expected=None):
    with social.lock, lock:
        root=_root(expected);media_id=_id(media_id)
        try:
            item=_metadata(root,media_id)
            if item.get('audience')!=audience:raise SocialError('Attachment belongs to another conversation')
            data=_read(root/(media_id+'.bin'),MAX_BYTES)
            if len(data)!=item['size']:raise SocialError('Attachment changed')
            return {'name':item['name'],'mime':item['mime'],'dataBase64':base64.b64encode(data).decode()}
        except (OSError,ValueError,KeyError):
            raise SocialError('Attachment is unavailable') from None

def remove(media_id):
    with social.lock, lock:
        root=_root();media_id=_id(media_id)
        for suffix in ('json','bin'):(root/(media_id+'.'+suffix)).unlink(missing_ok=True)


def store_result(result,*,audience,expected=None):
    if not isinstance(result,dict):raise SocialError('Invalid attachment result')
    if not isinstance(result.get('dataBase64'),str) or len(result['dataBase64'])>4*((MAX_BYTES+2)//3):raise SocialError('Invalid attachment result')
    try:data=base64.b64decode(result['dataBase64'],validate=True)
    except (KeyError,ValueError,TypeError):raise SocialError('Invalid attachment result') from None
    return store(result.get('name'),result.get('mime'),data,audience=audience,expected=expected)
