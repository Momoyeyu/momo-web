"""Release/source-build preparation for bundled ASR resources (never runtime).

  uv run python scripts/download_asr_models.py
  uv run python scripts/download_asr_models.py --verify-only

Pinned URLs and SHA256 hashes live in resources/asr/manifest.json. Existing
invalid files are repaired atomically; failures stop the release resource gate.
Players receive these resources in their initial installation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models" / "asr"
METADATA = ROOT / "resources" / "asr"


def valid(path: Path, entry: dict) -> bool:
    if not path.is_file() or path.stat().st_size != entry["size_bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == entry["sha256"]


def _download(url: str, dest: Path, entry: dict) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = dest.with_suffix(dest.suffix + ".part")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "momo-resource-builder/1"})
        with urllib.request.urlopen(request, timeout=60) as source, temporary.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
        if not valid(temporary, entry):
            raise ValueError(f"Checksum mismatch: {entry['path']}")
        temporary.replace(dest)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--output", type=Path, default=MODELS)
    args = parser.parse_args()
    manifest = json.loads((METADATA / "manifest.json").read_text())
    for entry in manifest["files"]:
        # Notices are versioned with the source and included in the same gate.
        checked_in = METADATA / entry["path"]
        dest = checked_in if checked_in.is_file() else args.output / entry["path"]
        if valid(dest, entry) and (not args.force or dest == checked_in):
            print(f"OK {entry['path']}")
            continue
        if args.verify_only:
            print(f"Missing/corrupt ASR resource: {dest}", file=sys.stderr)
            return 1
        if dest == checked_in:
            print(f"Corrupt source notice: {dest}", file=sys.stderr)
            return 1
        if "url" not in entry:
            print(f"Missing source notice: {entry['path']}", file=sys.stderr)
            return 1
        urls = [entry["url"]]
        mirror = os.environ.get("MOMO_MODEL_MIRROR")
        if mirror and urls[0].startswith("https://huggingface.co/"):
            urls.insert(0, urls[0].replace("https://huggingface.co", mirror.rstrip("/"), 1))
        for url in urls:
            try:
                _download(url, dest, entry)
                print(f"Prepared {entry['path']}")
                break
            except Exception as exc:
                print(f"Resource preparation failed: {entry['path']}: {exc}", file=sys.stderr)
        else:
            return 1
    print("ASR resources verified for offline distribution.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
