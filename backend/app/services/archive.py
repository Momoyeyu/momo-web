"""Explicit, bounded data transfer with SQLite online backup and verified staging."""

import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tempfile
import zipfile
import yaml
import uuid
from ..core import db, state
from . import memory

LIMIT = 512 * 1024 * 1024
MAX_FILES = 2048


def digest(data):
    return hashlib.sha256(data).hexdigest()


def export_data():
    with db._lock, tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "momo.db"
        with sqlite3.connect(target) as dest:
            db.conn().backup(dest)
        dest.close()
        files = {"momo.db": target.read_bytes()}
        files["momo.yaml"] = (
            state.STATE_PATH.read_bytes()
            if state.STATE_PATH.exists()
            else yaml.safe_dump(state.DEFAULT_STATE, allow_unicode=True).encode("utf-8")
        )
        ref = state.DATA_DIR / "tts"
        if ref.exists():
            for item in ref.iterdir():
                if item.is_file() and not item.is_symlink():
                    files["tts/" + item.name] = item.read_bytes()
        if sum(map(len, files.values())) > LIMIT:
            raise ValueError("Export exceeds size limit")
        manifest = {
            "format": "momo-data",
            "version": 1,
            "files": {
                name: {"size": len(data), "sha256": digest(data)}
                for name, data in files.items()
            },
        }
        out = io.BytesIO()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
            archive.writestr("manifest.json", json.dumps(manifest))
        return out.getvalue()


def validate(raw):
    if len(raw) > LIMIT:
        raise ValueError("Archive exceeds size limit")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        names = [item.filename for item in entries]
        if (
            len(entries) > MAX_FILES
            or len(set(names)) != len(names)
            or sum(item.file_size for item in entries) > LIMIT
        ):
            raise ValueError("Archive exceeds limits or contains duplicates")
        for item in entries:
            path = PurePosixPath(item.filename)
            if (
                item.is_dir()
                or path.is_absolute()
                or ".." in path.parts
                or "\\" in item.filename
                or ":" in item.filename
                or (item.external_attr >> 16) & 0o170000 == 0o120000
            ):
                raise ValueError("Invalid archive path")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("format") != "momo-data" or manifest.get("version") != 1:
            raise ValueError("Unsupported archive version")
        records = manifest.get("files", {})
        if set(records) != set(names) - {"manifest.json"} or "momo.db" not in records:
            raise ValueError("Archive manifest mismatch")
        files = {}
        for name, expected in records.items():
            if (
                name not in ("momo.db", "momo.yaml")
                and not (
                    name.startswith("tts/") and len(PurePosixPath(name).parts) == 2
                )
                and not (
                    name.startswith("avatars/")
                    and len(PurePosixPath(name).parts) == 2
                    and name.endswith(".zip")
                )
            ):
                raise ValueError("Unsupported archive entry")
            content = archive.read(name)
            if (
                len(content) != expected["size"]
                or digest(content) != expected["sha256"]
            ):
                raise ValueError("Archive integrity check failed")
            files[name] = content
        return files


def import_data(raw):
    files = validate(raw)
    previous_generation = int(
        db.query("SELECT generation FROM sessions WHERE id=?", (db.LIVE_ID,))[0][
            "generation"
        ]
    )
    root = state.DATA_DIR
    root.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".momo-import-", dir=root.parent) as tmp:
        stage = Path(tmp) / "new"
        stage.mkdir()
        for name, content in files.items():
            if name.startswith("avatars/"):
                continue
            item = stage / name
            item.parent.mkdir(parents=True, exist_ok=True)
            item.write_bytes(content)
        with sqlite3.connect(stage / "momo.db") as test:
            if test.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Invalid SQLite database")
            required = {"meta", "memories", "sessions", "messages"}
            if not required.issubset(
                {
                    r[0]
                    for r in test.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    )
                }
            ):
                raise ValueError("Unsupported database schema")
        if (stage / "momo.yaml").exists():
            if not isinstance(
                yaml.safe_load((stage / "momo.yaml").read_text(encoding="utf-8")), dict
            ):
                raise ValueError("Invalid configuration")
        else:
            # Early empty-profile backups omitted YAML; make their defaults explicit
            # so browser persistence cannot resurrect settings from before restore.
            (stage / "momo.yaml").write_text(
                yaml.safe_dump(state.DEFAULT_STATE, allow_unicode=True),
                encoding="utf-8",
            )
        memory.shutdown_index()
        with db._lock:
            db.reset()
            # Keep rollback outside TemporaryDirectory so even a failed restore or
            # interrupted import cannot erase the only previous copy.
            backup = root.parent / (root.name + ".pre-import-" + uuid.uuid4().hex)
            existed = root.exists()
            moved_previous = False
            installed = False
            try:
                if existed:
                    os.replace(root, backup)
                    moved_previous = True
                os.replace(stage, root)
                installed = True
                # Validate application schema before removing the rollback copy.
                db.conn()
                with db.tx() as restored:
                    imported_generation = int(
                        restored.execute(
                            "SELECT generation FROM sessions WHERE id=?", (db.LIVE_ID,)
                        ).fetchone()[0]
                    )
                    restored.execute(
                        "UPDATE sessions SET generation=?,summary_version=summary_version+1 WHERE id=?",
                        (max(previous_generation, imported_generation) + 1, db.LIVE_ID),
                    )
                    restored.execute(
                        "UPDATE runs SET status='interrupted',updated_at=? WHERE status IN ('processing','generated')",
                        (db.now_iso(),),
                    )
            except BaseException:
                db.reset()
                if installed and root.exists():
                    shutil.rmtree(root)
                if moved_previous:
                    os.replace(backup, root)
                raise
            else:
                if moved_previous:
                    shutil.rmtree(backup)
        memory.schedule_index()
