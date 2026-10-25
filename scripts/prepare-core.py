"""Fetch the pinned Cubism Core build input; verify before replacing any file."""
from pathlib import Path
import hashlib
import json
import urllib.request

app = Path(__file__).resolve().parents[1]
manifest = json.loads((app / 'migration/cubism-core.json').read_text())
target = app / 'frontend/public/live2d/live2dcubismcore.min.js'
def valid(data):
    return len(data) == manifest['size_bytes'] and hashlib.sha256(data).hexdigest() == manifest['sha256']
if target.is_file() and valid(target.read_bytes()):
    print('Pinned Cubism Core already verified')
else:
    request = urllib.request.Request(manifest['url'], headers={'User-Agent': 'momo-resource-builder/1'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    if not valid(data):
        raise ValueError('Cubism Core checksum mismatch; build input was not replaced')
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix('.download')
    temp.write_bytes(data)
    temp.replace(target)
    print('Pinned Cubism Core fetched and verified')
