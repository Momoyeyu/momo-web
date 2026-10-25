"""Verify and stage the accepted offline model archive for native bundling."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
args = parser.parse_args()
pin = json.loads(Path(__file__).with_name('offline-resources.json').read_text())
with args.archive.open('rb') as stream:
    checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
if args.archive.stat().st_size != pin['size_bytes'] or checksum != pin['sha256']:
    raise ValueError('Offline resource archive does not match the accepted pinned bundle')
target = Path(__file__).resolve().parents[1] / 'resources/models'
with zipfile.ZipFile(args.archive) as archive:
    for item in archive.infolist():
        path = Path(item.filename)
        if path.is_absolute() or '..' in path.parts or item.is_dir():
            if not item.is_dir():
                raise ValueError('Unsafe resource archive path')
            continue
        if path.parts[0] not in {'asr', 'embedding', 'resource-manifest.json'}:
            raise ValueError(f'Unexpected resource: {path}')
        dest = target / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(archive.read(item))
manifest = json.loads((target / 'resource-manifest.json').read_text())
for entry in manifest['files']:
    file = (target / entry['path']).resolve()
    if not file.is_relative_to(target.resolve()) or file.stat().st_size != entry['size_bytes']:
        raise ValueError(f"Resource size mismatch: {entry['path']}")
    if hashlib.sha256(file.read_bytes()).hexdigest() != entry['sha256']:
        raise ValueError(f"Resource checksum mismatch: {entry['path']}")
print(f"Verified {len(manifest['files'])} resource files")
print(f'Offline resources staged: {target}')
