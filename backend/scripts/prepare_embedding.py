#!/usr/bin/env python3
"""Release-time resource preparation. Runtime never fetches resources.

Run `uv run python scripts/prepare_embedding.py` before packaging; --verify-only
checks an offline resource tree. Manifest hashes pin the export and tokenizer.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import urllib.request

DEFAULT = Path(__file__).resolve().parents[1] / 'resources/embedding/multilingual-e5-small'


def valid(path: Path, entry: dict) -> bool:
    if not path.is_file() or path.stat().st_size != entry['size_bytes']:
        return False
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest() == entry['sha256']


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=DEFAULT)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    manifest_path = DEFAULT / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    for entry in manifest['files']:
        target = args.output / entry['path']
        if valid(target, entry):
            print(f'OK {entry["path"]}')
            continue
        if args.verify_only:
            raise SystemExit(f'Missing or invalid bundled resource: {target}')
        with tempfile.TemporaryDirectory(prefix='momo-embedding-') as tmp:
            if entry['path'] in ('model_quantized.onnx', 'tokenizer.json'):
                from huggingface_hub import hf_hub_download
                upstream_path = 'onnx/model_quantized.onnx' if entry['path'].endswith('.onnx') else entry['path']
                fetched = Path(hf_hub_download(manifest['source_repository'], upstream_path,
                    revision=manifest['source_revision'], local_dir=tmp))
            else:
                fetched = Path(tmp) / entry['path']
                with urllib.request.urlopen(entry['url'], timeout=60) as source, fetched.open('wb') as output:
                    shutil.copyfileobj(source, output)
            if not valid(fetched, entry):
                raise SystemExit(f'Checksum failed for {entry["path"]}; refusing to package')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(fetched, target)
        print(f'Prepared {entry["path"]}')
    if args.output.resolve() != DEFAULT.resolve():
        shutil.copyfile(manifest_path, args.output / 'manifest.json')
    print('Embedding resources verified for offline distribution.')


if __name__ == '__main__':
    main()
