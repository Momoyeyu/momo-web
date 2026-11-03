"""User-visible channel content, separate from model-only attachment annotations."""
import json
from ..core import db

def incoming(row):
    if 'display_text' in row.keys() and row['display_text'] is not None:
        return row['display_text']
    text=row['text']
    # Legacy entries predate the original-text projection. Remove only the
    # exact annotations generated for the attached images, not arbitrary prose.
    for item in json.loads(row['attachments'] or '[]'):
        if item.get('kind')!='image': continue
        name=item.get('name','图片')
        for suffix in ('; 内容以实际读取结果为准','；原始内容未授权读取'):
            text=text.replace('[QQ图片: '+name+suffix+']','')
    return text

def for_run(run_id, fallback):
    if not db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox'"):
        return fallback
    rows=db.query('SELECT * FROM inbox WHERE source="qq" AND (run_id=? OR retry_of=?) ORDER BY seq DESC LIMIT 1',(run_id,run_id))
    return incoming(rows[0]) if rows else fallback
