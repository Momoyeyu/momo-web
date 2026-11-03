"""Private image facts, scoped request projection and native vision verification.

Bytes live in SQLite, never in dialogue text, tools, summaries or credentials.
Only materialize() creates ephemeral provider data URLs after authorization.
"""
from __future__ import annotations
import base64
import copy
import hashlib
import io
import json
import math
import re
import secrets
import time
import warnings

import httpx
from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError
from ..core import db, state
from ..core.llm import LlmError, _thinking_payload

MAX_BYTES = 10 * 1024 * 1024
MAX_COUNT = 4
MAX_PIXELS = 20_000_000
MAX_STORED = 3 * 1024 * 1024
MAX_LIBRARY = 256 * 1024 * 1024
FORMATS = {'PNG', 'JPEG', 'WEBP', 'GIF'}

class VisionError(ValueError):
    pass


def schema():
    with db._lock:
        c = db.conn()
        c.execute('''CREATE TABLE IF NOT EXISTS vision_images(
            id TEXT PRIMARY KEY, audience TEXT NOT NULL, scope TEXT NOT NULL,
            mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
            animated INTEGER NOT NULL, data BLOB NOT NULL, created REAL NOT NULL)''')
        c.execute('CREATE TABLE IF NOT EXISTS run_images(run_id TEXT NOT NULL,image_id TEXT NOT NULL,PRIMARY KEY(run_id,image_id))')
        c.execute('CREATE TABLE IF NOT EXISTS vision_proofs(fingerprint TEXT PRIMARY KEY,at REAL NOT NULL)')


def fingerprint(cfg):
    return hashlib.sha256(json.dumps([cfg.get(k, '') for k in ('url', 'key', 'model')]).encode()).hexdigest()


def verified(cfg):
    schema()
    return bool(db.query('SELECT 1 FROM vision_proofs WHERE fingerprint=?', (fingerprint(cfg),)))


def enabled(cfg=None):
    cfg = cfg if cfg is not None else state.load()['settings']['llm']
    return cfg.get('vision') is True and verified(cfg)


def require_enabled(cfg=None):
    if not enabled(cfg):
        raise VisionError('vision.disabled')


def normalize(raw):
    if not raw or len(raw) > MAX_BYTES:
        raise VisionError('vision.size')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in FORMATS or image.width * image.height > MAX_PIXELS:
                    raise VisionError('vision.format')
                animated = bool(getattr(image, 'is_animated', False))
                image.seek(0)
                image = ImageOps.exif_transpose(image).convert('RGBA')
                image.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
                # Fresh pixels strip EXIF, XMP, comments and embedded profiles.
                clean = Image.new('RGB', image.size, 'white')
                clean.paste(image, mask=image.getchannel('A'))
                out = io.BytesIO()
                clean.save(out, 'JPEG', quality=88, optimize=True)
                data = out.getvalue()
                if len(data) > MAX_STORED:
                    raise VisionError('vision.size')
                return data, clean.width, clean.height, animated
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombWarning, Image.DecompressionBombError) as error:
        if isinstance(error, VisionError):
            raise
        raise VisionError('vision.format') from None


def store(raw, *, audience='owner', scope=None):
    data, width, height, animated = normalize(raw)
    schema()
    image_id = secrets.token_hex(16)
    with db.tx() as c:
        # Remove abandoned drafts; attached history is never evicted for space.
        c.execute('DELETE FROM vision_images WHERE created<? AND NOT EXISTS(SELECT 1 FROM run_images r JOIN messages m ON m.run_id=r.run_id WHERE r.image_id=vision_images.id AND m.visible=1)', (time.time()-86400,))
        size = c.execute('SELECT COALESCE(SUM(length(data)),0) FROM vision_images').fetchone()[0]
        if size + len(data) > MAX_LIBRARY:
            raise VisionError('vision.libraryFull')
        c.execute('INSERT INTO vision_images VALUES(?,?,?,?,?,?,?,?,?)', (image_id, audience, json.dumps(scope or {}), 'image/jpeg', width, height, int(animated), data, time.time()))
    return {'id':image_id, 'mime':'image/jpeg', 'width':width, 'height':height, 'animated':animated}


def _row(image_id, audience=None):
    if not isinstance(image_id, str) or not re.fullmatch('[a-f0-9]{32}', image_id):
        raise VisionError('vision.unavailable')
    schema()
    rows = db.query('SELECT * FROM vision_images WHERE id=?', (image_id,))
    if not rows or audience is not None and rows[0]['audience'] != audience:
        raise VisionError('vision.unavailable')
    row = dict(rows[0])
    scope = json.loads(row['scope'])
    if scope.get('source') == 'qq':
        from .social import social
        with social.lock:
            account = social._account('qq')
            if (not account['enabled'] or not account['permissions'].get('media')
                or account['accountId'] != scope.get('accountId')
                or account.get('expectedSelfId') != scope.get('selfId')
                or not social._scope_allowed(account, scope.get('peerId', ''))
                or social._audience(account, scope.get('peerId', '')) != row['audience']):
                raise VisionError('vision.unavailable')
    return row


def metadata(image_id, audience=None):
    row = _row(image_id, audience)
    return {key:row[key] for key in ('id','mime','width','height','animated')}


def body(image_id):
    row = _row(image_id)
    return row['data'], row['mime']


def remove_image(image_id):
    _row(image_id)  # Locally authenticated explicit deletion, same account gates.
    with db.tx() as c:
        c.execute('DELETE FROM vision_images WHERE id=?', (image_id,))


def remove_draft(image_id):
    _row(image_id, 'owner')
    with db.tx() as c:
        c.execute('DELETE FROM vision_images WHERE id=? AND NOT EXISTS(SELECT 1 FROM run_images r JOIN messages m ON m.run_id=r.run_id WHERE r.image_id=? AND m.visible=1)', (image_id, image_id))


def validate_ids(ids, *, audience='owner', local=False):
    if not isinstance(ids, list) or len(ids) > MAX_COUNT or any(not isinstance(i,str) for i in ids) or len(set(ids)) != len(ids):
        raise VisionError('vision.count')
    for image_id in ids:
        row = _row(image_id, audience)
        if local and json.loads(row['scope']).get('source') == 'qq':
            raise VisionError('vision.unavailable')
    return ids


def bind(run_id, ids, audience):
    validate_ids(ids, audience=audience)
    with db.tx() as c:
        for image_id in ids:
            c.execute('INSERT OR IGNORE INTO run_images VALUES(?,?)', (run_id, image_id))


def for_run(run_id):
    schema()
    result = []
    for row in db.query('SELECT image_id FROM run_images WHERE run_id=? ORDER BY rowid', (run_id,)):
        try: result.append(metadata(row['image_id']))
        except VisionError: result.append({"id":row["image_id"],"mime":"image/jpeg","width":1,"height":1,"unavailable":True})
    return result


def parts(text, ids, *, audience, cfg, compact=False):
    if not ids:
        return text
    result = [{'type':'text', 'text':text or '[Image]'}]
    for image_id in ids:
        # Existence of an image is a fact even if its bytes are no longer authorized.
        result.append({'type':'text','text':f'[Image reference: {image_id}]'})
        if not compact and enabled(cfg):
            try:
                row = _row(image_id, audience)
                result.append({'type':'image_url','image_url':{'url':'momo-image:'+image_id},
                               'vision_tokens':image_cost(row['width'],row['height'])})
            except VisionError:
                result.append({'type':'text','text':'[Image unavailable; do not guess its contents.]'})
    return result


def image_cost(width, height):
    # Provider-neutral conservative tile allowance, not base64 length or an
    # exact vendor tokenizer. Server usage still feeds the normal 009 policy.
    return 1024 + math.ceil(width/512)*math.ceil(height/512)*1024


def fit_history(messages, cfg, tools=None):
    """Retain current pixels; shed optional old pixels before hard capacity checks.

    Text observations and image references remain intact. Only the transient
    request changes, never the gallery or persisted history. Current images
    alone exceeding capacity still fail through the normal hard guard.
    """
    from .context_policy import Budget, estimate
    safe = Budget.from_config(cfg).safe
    latest_user = max((i for i,m in enumerate(messages) if m.get('role')=='user'),default=-1)
    for index,message in enumerate(messages):
        if index==latest_user or not isinstance(message.get('content'),list): continue
        for part in list(message['content']):
            if estimate(messages,tools)<=safe: return
            if part.get('type')=='image_url': message['content'].remove(part)


def materialize(messages, cfg, audience):
    output = copy.deepcopy(messages)
    for message in output:
        if not isinstance(message.get('content'), list): continue
        for part in message['content']:
            if part.get('type') != 'image_url': continue
            require_enabled(cfg)
            # Revocation/config edits while waiting for inference must win.
            current = state.load()['settings']['llm']
            if fingerprint(current) != fingerprint(cfg) or not enabled(current):
                raise VisionError('vision.changed')
            ref = part['image_url']['url']
            if not ref.startswith('momo-image:'): raise VisionError('vision.unavailable')
            row = _row(ref.removeprefix('momo-image:'), audience)
            part.pop('vision_tokens', None)
            part['image_url'] = {'url':'data:'+row['mime']+';base64,'+base64.b64encode(row['data']).decode(), 'detail':'high'}
    return output


async def probe(cfg):
    """A content challenge, not merely 200 OK or unreliable /models metadata."""
    from urllib.parse import urlsplit
    try:
        url = urlsplit(cfg.get('url', ''))
        if url.scheme not in {'http','https'} or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError()
        url.port
        if not cfg.get('model'): raise ValueError()
    except ValueError:
        return {'ok':False,'detail':'unconfigured'}
    code = ''.join(secrets.choice('23456789') for _ in range(6))
    image = Image.new('RGB',(360,100),'white')
    font = ImageFont.load_default(size=55)
    draw = ImageDraw.Draw(image)
    for index,digit in enumerate(code):
        draw.text((25+50*index,12),digit,fill='black',font=font)
    out = io.BytesIO();image.save(out,'PNG')
    payload = {'model':cfg['model'],'stream':False,'max_tokens':128,
               'messages':[{'role':'user','content':[{'type':'text','text':'Read the six digits in this image. Reply only with those digits.'},
               {'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()}}]}]}
    try:
        _thinking_payload(cfg, payload)
        async with httpx.AsyncClient(timeout=30,trust_env=False,follow_redirects=False) as client:
            response = await client.post(cfg['url'].rstrip('/')+'/v1/chat/completions',json=payload,
                       headers={'Authorization':'Bearer '+cfg['key']} if cfg.get('key') else {})
        if response.status_code != 200: return {'ok':False,'detail':f'HTTP {response.status_code}'}
        content = response.json()['choices'][0]['message']['content']
        if not isinstance(content,str) or content.strip() != code:
            return {'ok':False,'detail':'not verified'}
        schema()
        with db.tx() as c:
            c.execute('INSERT OR REPLACE INTO vision_proofs VALUES(?,?)',(fingerprint(cfg),time.time()))
        return {'ok':True,'detail':'verified'}
    except httpx.TimeoutException: return {'ok':False,'detail':'timeout'}
    except httpx.HTTPError: return {'ok':False,'detail':'unreachable'}
    except (ValueError,KeyError,IndexError,TypeError,LlmError): return {'ok':False,'detail':'invalid response'}


def qq_images(coordinator, incoming):
    """Fetch only image elements in this already admitted event, not history."""
    refs = [item for item in json.loads(incoming['attachments']) if item.get('kind') == 'image']
    if not refs: return []
    if len(refs) > MAX_COUNT: raise VisionError('vision.count')
    from . import checkpoint
    with checkpoint.audience_scope(incoming['audience']):
        cached = for_run(incoming['run_id'])
        if len(cached) == len(refs): return [item['id'] for item in cached]
        ids = []
        try:
            for ref in refs:
                result = coordinator.social_action('media.incoming', {
                    'peerId':incoming['peer_id'], 'messageId':ref.get('messageId') or incoming['raw_external_id'], 'elementId':ref['elementId']})['result']
                raw = base64.b64decode(result['dataBase64'], validate=True)
                image = store(raw, audience=incoming['audience'], scope={'source':'qq','accountId':incoming['account_id'],
                              'selfId':incoming['self_id'],'peerId':incoming['peer_id']})
                ids.append(image['id'])
            # No images attach until every image in the batch was fetched.
            bind(incoming['run_id'],ids,incoming['audience'])
            return ids
        except Exception:
            with db.tx() as c:
                for image_id in ids: c.execute('DELETE FROM vision_images WHERE id=?', (image_id,))
            raise


def read_tool(args):
    from . import checkpoint
    image_id = args.get('imageId')
    require_enabled()
    row = _row(image_id, checkpoint.audience())
    # Only already admitted facts can be read by a model, never draft assets.
    if not db.query('SELECT 1 FROM run_images WHERE image_id=?', (image_id,)):
        raise VisionError('vision.unavailable')
    scope = json.loads(row['scope'])
    if scope.get('source') == 'qq':
        from .social import social
        if not social._account('qq')['permissions'].get('history'):
            raise VisionError('vision.historyDenied')
    return json.dumps({'imageId':image_id})
