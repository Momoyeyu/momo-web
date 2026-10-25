#!/usr/bin/env python3
"""Reviewed, one-way Git snapshot promotion. Default is a non-mutating dry run."""

from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import os

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = {
    "frontend/": "app/frontend/",
    "backend/": "app/backend/",
    "plugin-host/": "app/plugin-host/",
}
FILES = {
    f"scripts/{name}": f"app/scripts/{name}"
    for name in ("prepare-core.py", "prepare-models.py", "offline-resources.json")
}
FILES.update(
    {
        "migration/cubism-core.json": "app/migration/cubism-core.json",
        ".env.example": "app/.env.example",
    }
)
MANIFEST = "app/migration/web-source.json"


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def destination(name):
    if name in FILES:
        return FILES[name]
    for prefix, target in PREFIXES.items():
        if name.startswith(prefix):
            return target + name[len(prefix) :]
    return None


def source_name(target):
    for name, mapped in FILES.items():
        if target == mapped:
            return name
    for prefix, mapped in PREFIXES.items():
        if target.startswith(mapped):
            return prefix + target[len(mapped) :]
    return None


def safe_target(root, name):
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("Invalid target path")
    target = root / relative
    cursor = target
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError(f"Unsafe target symlink: {name}")
        cursor = cursor.parent
    return target


def snapshot(source, revision):
    files = {}
    for line in git(source, "ls-tree", "-rz", "--full-tree", revision).split(b"\0"):
        if not line:
            continue
        meta, raw = line.split(b"\t", 1)
        name = raw.decode()
        target = destination(name)
        if not target:
            continue
        if meta.split()[0] != b"100644" and meta.split()[0] != b"100755":
            raise ValueError(f"Refusing non-regular source: {name}")
        if any(
            part
            in {
                ".env",
                "data",
                "node_modules",
                ".venv",
                "test-results",
                "playwright-report",
                "__pycache__",
            }
            for part in Path(name).parts
        ) or name.endswith((".db", ".sqlite", ".sqlite3")):
            raise ValueError(f"Refusing private/generated source: {name}")
        raw = git(source, "show", f"{revision}:{name}")
        files[target] = {
            "source": name,
            "sha256": sha(raw),
            "mode": int(meta.split()[0], 8),
            "raw": raw,
        }
    return files


def promote(source, target, revision, bootstrap=False, apply=False, checks=()):
    source = Path(source).resolve()
    target = Path(target).resolve()
    if source == target:
        raise ValueError("Source and target must differ")
    revision = git(source, "rev-parse", revision + "^{commit}").decode().strip()
    if git(source, "status", "--porcelain", "--untracked-files=normal").strip():
        raise ValueError("Commit the reviewed source before promotion")
    files = snapshot(source, revision)
    if not files:
        raise ValueError("Empty source snapshot")
    manifest_path = safe_target(target, MANIFEST)
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    if previous is None and not bootstrap:
        raise ValueError("First import requires explicit --bootstrap")
    old = previous["files"] if previous else {}
    bootstrap_revision = None
    if previous is None:
        # The first import explicitly takes ownership of the target's tracked
        # shared baseline, including files this Web revision has retired.
        bootstrap_revision = git(target, "rev-parse", "HEAD").decode().strip()
        for name in (
            git(target, "ls-tree", "-rz", "--name-only", "HEAD").decode().split("\0")
        ):
            original = source_name(name)
            if original:
                raw = git(target, "show", f"HEAD:{name}")
                old[name] = {"source": original, "sha256": sha(raw)}
    # Every previously owned file must still match, including files to be deleted.
    for name, record in old.items():
        if not destination(record["source"]) == name:
            raise ValueError("Invalid previous ownership manifest")
        p = safe_target(target, name)
        if p.is_symlink() or not p.is_file() or sha(p.read_bytes()) != record["sha256"]:
            raise ValueError(f"Target drift: {name}")
    for name in files.keys() - old.keys():
        p = safe_target(target, name)
        if p.exists() or p.is_symlink():
            if previous:
                raise ValueError(f"Unowned target collision: {name}")
            if p.is_symlink() or not p.is_file():
                raise ValueError(f"Unsafe target: {name}")
            try:
                baseline = git(target, "show", f"HEAD:{name}")
            except subprocess.CalledProcessError as error:
                raise ValueError(f"Untracked target collision: {name}") from error
            if sha(p.read_bytes()) != sha(baseline):
                raise ValueError(f"Uncommitted target: {name}")
    owned_roots = list(PREFIXES.values()) + [MANIFEST, *FILES.values()]
    if git(
        target, "status", "--porcelain", "--untracked-files=normal", "--", *owned_roots
    ).strip():
        raise ValueError("Target shared paths have local changes")
    changed = [
        name
        for name, r in files.items()
        if not (target / name).is_file()
        or sha((target / name).read_bytes()) != r["sha256"]
    ]
    deleted = sorted(old.keys() - files.keys())
    record = {
        "format": "momo-web-source",
        "version": 1,
        "revision": revision,
        "checks": list(checks),
        "files": {
            n: {k: v for k, v in r.items() if k != "raw"}
            for n, r in sorted(files.items())
        },
        "deleted": deleted,
    }
    if bootstrap_revision:
        record["bootstrapRevision"] = bootstrap_revision
    elif previous and previous.get("bootstrapRevision"):
        record["bootstrapRevision"] = previous["bootstrapRevision"]
    report = {
        "revision": revision,
        "changed": sorted(changed),
        "deleted": deleted,
        "fileCount": len(files),
        "applied": apply,
    }
    if previous and previous["revision"] == revision and not changed and not deleted:
        return report
    if apply:
        backup = {
            name: (target / name).read_bytes() if (target / name).exists() else None
            for name in [*changed, *deleted, MANIFEST]
        }
        try:
            for name in changed:
                p = target / name
                p.parent.mkdir(parents=True, exist_ok=True)
                with tempfile.NamedTemporaryFile(dir=p.parent, delete=False) as tmp:
                    tmp.write(files[name]["raw"])
                    staged = tmp.name
                os.chmod(staged, files[name]["mode"] & 0o777)
                os.replace(staged, p)
            for name in deleted:
                (target / name).unlink()
            manifest_path.parent.mkdir(parents=True, exist_ok=True)
            manifest_path.write_text(
                json.dumps(record, indent=2, ensure_ascii=False) + "\n"
            )
        except Exception:
            for name, raw in backup.items():
                p = target / name
                if raw is None:
                    p.unlink(missing_ok=True)
                else:
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(raw)
            raise
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, type=Path)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument(
        "--check",
        action="append",
        default=[],
        help="Recorded verification evidence, not an executed command",
    )
    args = parser.parse_args()
    try:
        print(
            json.dumps(
                promote(
                    ROOT,
                    args.target,
                    args.revision,
                    args.bootstrap,
                    args.apply,
                    args.check,
                ),
                ensure_ascii=False,
                indent=2,
            )
        )
    except ValueError as error:
        parser.exit(1, str(error) + "\n")
