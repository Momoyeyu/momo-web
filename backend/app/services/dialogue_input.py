"""One model-facing input for local and plugin dialogue.

The inbox retains the sender's original payload. Normalized speech is user
content, and attachment failures are trusted, static observations only.
"""
from dataclasses import dataclass, field
import base64
import io
import json
import wave
import secrets
from ..core import db

from . import asr, checkpoint, vision
from ..core.plugin_host import HostError


@dataclass
class DialogueInput:
    text: str
    images: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    speech: list[str] = field(default_factory=list)


def pcm_bytes(raw, mime):
    if mime != 'audio/x-momo-pcm16':
        try:
            with wave.open(io.BytesIO(raw)) as wav:
                if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, 16000):
                    raise ValueError('unsupported audio format')
                raw = wav.readframes(16000 * 120 + 1)
        except (wave.Error, EOFError) as error:
            raise ValueError('unsupported audio format') from error
    if not raw or len(raw) % 2 or len(raw) > 32000 * 120:
        raise ValueError('invalid voice length')
    return raw


def transcribe(raw, lang):
    session = asr.AsrSession(lang)
    try:
        events = []
        for offset in range(0, len(raw), 32000):
            events.extend(session.feed(raw[offset:offset + 32000]))
        events.extend(session.flush())
        text = ' '.join(e['text'] for e in events if e['type'] == 'transcript').strip()
        if not text:
            raise ValueError('no recognizable speech')
        return text
    finally:
        session.close()


def voice_schema():
    with db._lock:
        db.conn().execute("""CREATE TABLE IF NOT EXISTS dialogue_voice(
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL, element_id TEXT NOT NULL,
            audience TEXT NOT NULL, scope TEXT NOT NULL, pcm BLOB NOT NULL, transcript TEXT,
            UNIQUE(run_id, element_id))""")


def store_voice(row, element_id, pcm):
    voice_schema()
    scope = dict(source=row['source'], accountId=row['account_id'], selfId=row['self_id'], peerId=row['peer_id'])
    vision.check_media_scope(scope, row['audience'])
    with db.tx() as conn:
        if conn.execute('SELECT 1 FROM dialogue_voice WHERE run_id=? AND element_id=?',
                        (row['run_id'], element_id)).fetchone():
            return
        if conn.execute('SELECT COALESCE(SUM(length(pcm)),0) FROM dialogue_voice').fetchone()[0] + len(pcm) > vision.MAX_LIBRARY:
            raise ValueError('voice storage full')
        conn.execute('INSERT INTO dialogue_voice VALUES(?,?,?,?,?,?,NULL)',
                     (secrets.token_hex(16), row['run_id'], element_id, row['audience'], json.dumps(scope), pcm))


def media_for_run(run_id):
    voice_schema()
    images = vision.for_run(run_id)
    voices = []
    for clip in db.query('SELECT id, scope, audience FROM dialogue_voice WHERE run_id=? ORDER BY rowid', (run_id,)):
        try:
            vision.check_media_scope(json.loads(clip['scope']), clip['audience'])
            voices.append(clip['id'])
        except vision.VisionError:
            continue
    return {**({'images': images} if images else {}), **({'voices': voices} if voices else {})}


def voice_wav(clip_id):
    voice_schema()
    rows = db.query('SELECT * FROM dialogue_voice WHERE id=?', (clip_id,))
    if not rows:
        raise ValueError('unavailable')
    clip = rows[0]
    vision.check_media_scope(json.loads(clip['scope']), clip['audience'])
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(clip['pcm'])
    return out.getvalue()


def from_inbox(coordinator, row):
    from .coordinator import CoordinationError
    from .prompt import conversation_lang
    from ..core.state import load
    content = DialogueInput(row['text'])
    if row['source'] != 'qq':
        return content
    refs = json.loads(row['attachments'])
    errors = (HostError, CoordinationError, ValueError, asr.AsrError)
    with checkpoint.audience_scope(row['audience']):
        if any(ref['kind'] == 'image' for ref in refs):
            try:
                ids = vision.qq_images(coordinator, row)
                if vision.enabled():
                    content.images = ids[:vision.MAX_COUNT]
                    if len(ids) > vision.MAX_COUNT:
                        content.notes.append('Additional images were received beyond the current request limit.')
                elif ids:
                    content.notes.append('Images were received but vision is disabled. Do not claim to see them.')
                if len(ids) < sum(ref['kind'] == 'image' for ref in refs):
                    content.notes.append('Some image content was unavailable. Do not invent its contents.')
            except errors:
                content.notes.append('Image content was unavailable. Do not guess the cause or its contents.')
        for ref in refs:
            if ref['kind'] != 'audio':
                continue
            try:
                item = coordinator.social_action('media.incoming', {
                    'peerId': row['peer_id'], 'elementId': ref['elementId'],
                    'messageId': ref.get('messageId') or row['raw_external_id']})['result']
                pcm = pcm_bytes(base64.b64decode(item['dataBase64'], validate=True), item.get('mime'))
                store_voice(row, ref['elementId'], pcm)
                speech = transcribe(pcm, conversation_lang(load()))
                content.speech.append(speech)
                with db.tx() as conn:
                    conn.execute('UPDATE dialogue_voice SET transcript=? WHERE run_id=? AND element_id=?',
                                 (speech, row['run_id'], ref['elementId']))
            except errors:
                content.notes.append('A voice message could not be transcribed. Do not invent its contents.')
    return content
