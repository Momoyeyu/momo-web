"""Profile-scoped Mod inventory with immutable installations and atomic selection."""
from contextlib import nullcontext
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import tempfile
import threading
import uuid
from urllib.parse import quote

import httpx

from ..core import state
from . import mod_bundle

_lock = threading.RLock()
_retiring = set()


class ModRuntimeError(RuntimeError):
    pass


def _root():
    return state.DATA_DIR.resolve() / "mods"


def _record_path(ident):
    return _root() / "installed" / (mod_bundle.mod_id(ident) + ".json")


def _read(ident):
    try:
        record = json.loads(_record_path(ident).read_bytes())
        if (not isinstance(record, dict) or not isinstance(record.get("manifest"), dict)
                or record["manifest"].get("id") != ident or type(record.get("enabled")) is not bool
                or not isinstance(record.get("package"), str) or not re.fullmatch(r"[0-9a-f]{32}", record["package"])):
            raise ValueError("Invalid installed Mod record")
        return record
    except FileNotFoundError:
        return None


def _save(record):
    target = _record_path(record["manifest"]["id"])
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, target)
    finally:
        Path(name).unlink(missing_ok=True)


def _directory(record):
    return _root() / "packages" / uuid.UUID(hex=record["package"]).hex


def _public(record):
    m = record["manifest"]
    return {**{k: m[k] for k in ("id", "kind", "version", "name", "platforms")},
            "source": "official" if m["kind"] == "integration" else "local",
            "enabled": record["enabled"], "capabilities": m.get("capabilities", []),
            "runtimeError": record.get("runtimeError"),
            "resources": [{**r, "url": f"/api/mods/{m['id']}/assets/{quote(r['path'])}?v={record['package']}"}
                          for r in m.get("resources", [])]}


def listing():
    with _lock:
        return [_public(json.loads(p.read_bytes())) for p in sorted((_root() / "installed").glob("*.json"))]


def integration_root(ident):
    if ident not in mod_bundle.OFFICIAL or ident in _retiring:
        return None
    # Reader and host callbacks must never wait for a pending stop RPC.
    try:
        record = _read(ident)
    except (OSError, ValueError):
        return None
    if record and record["enabled"] and record["manifest"].get("kind") == "integration":
        return _directory(record)
    return None


def _binding(record):
    m = record["manifest"]
    # Verify the signed inventory again before loading executable modules after restart.
    mod_bundle._manifest(json.dumps(m))
    root = _directory(record)
    files = m["files"]
    if (root.resolve() != root.absolute() or not root.is_dir()
            or any(p.is_symlink() or (not p.is_dir() and str(p.relative_to(root).as_posix()) not in files)
                   for p in root.rglob("*"))):
        raise ValueError("Installed integration has unexpected files")
    for path, expected in files.items():
        with (root / path).open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() != expected:
                raise ValueError("Installed integration checksum mismatch")
    private = state.DATA_DIR.resolve() / "mod-data" / m["id"]
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    result = {"modRoot": str(root.resolve()), "modEntrypoint": str((root / m["entrypoints"][mod_bundle.current_platform()]).resolve()),
              "privateRoot": str(private.resolve())}
    if private.resolve() != private.absolute():
        raise ValueError("Invalid integration data directory")
    private.chmod(0o700)
    return result


def _configure(record, enabled, host=None):
    from .coordinator import runtime
    host = host or runtime.host
    if not host:
        raise ModRuntimeError("Integration host unavailable")
    ident = record["manifest"]["id"]
    binding = _binding(record) if enabled else None
    # QQ resource preparation may take minutes. Keep desktop revocation and
    # Minecraft input on the coordinator control lane available meanwhile.
    with host.control if ident == "momo.minecraft" else nullcontext():
        if not enabled and ident == "momo.minecraft":
            from .minecraft import minecraft
            minecraft.stop("Mod disabled", notify=False)
        reply = host.request("mods.configure", {"id": ident, "binding": binding},
                     timeout=240 if enabled else 45)
        if reply.get("id") != ident or reply.get("enabled") is not enabled or (not enabled and reply.get("stopped") is not True):
            raise ModRuntimeError("Unconfirmed integration transition")


def _stop(record, *, updating=False):
    disabled = {**record, "enabled": False}
    disabled.pop("runtimeError", None)
    pending = {**disabled, "runtimeError": "Integration stop unconfirmed"}
    # An interrupted upgrade boots the previous selected package. A user's
    # explicit disable must survive restart even before the transport replies.
    if not updating:
        _save(pending)
    try:
        _configure(record, False)
        if record["manifest"]["id"] == "momo.qq":
            from .social import social
            social.invalidate_mod_authority()
    except Exception as error:
        _save(pending)
        raise ModRuntimeError(pending["runtimeError"]) from error
    if not updating:
        _save(disabled)
    return disabled


def _enable(record, host=None, *, fallback=None):
    try:
        _configure(record, True, host)
        enabled = {**record, "enabled": True}
        enabled.pop("runtimeError", None)
        _save(enabled)
        return enabled
    except Exception as error:
        disabled = {**(fallback or record), "enabled": False, "runtimeError": f"Integration activation failed: {error}"}
        try:
            _configure(record, False, host)
        except Exception:
            disabled["runtimeError"] += "; stop unconfirmed"
            _save(disabled)
            raise ModRuntimeError(disabled["runtimeError"]) from error
        if fallback and fallback["enabled"]:
            _enable(fallback, host)
        else:
            _save(disabled)
        raise ModRuntimeError(disabled["runtimeError"]) from error


def restore(host):
    """Run once on a fresh host, before requests can stage another installation."""
    with _lock:
        pinned = set()
        can_clean = True
        for path in sorted((_root() / "installed").glob("*.json")):
            try:
                record = _read(path.stem)
                pinned.add(record["package"])
                if path.stem in mod_bundle.OFFICIAL and record["enabled"]:
                    _enable(record, host)
                if record.get("runtimeError"):
                    can_clean = False
            except (KeyError, TypeError, ValueError, OSError, ModRuntimeError):
                # Keep all files on ambiguous state. A failed integration cannot
                # prevent chat startup or cause cleanup of an unconfirmed executor.
                can_clean = False
        if can_clean:
            for directory in (_root() / "packages").glob("*"):
                managed = re.fullmatch(r"[a-f0-9]{32}|\.stage-[a-zA-Z0-9_-]+", directory.name)
                if managed and directory.name not in pinned and directory.is_dir() and not directory.is_symlink():
                    shutil.rmtree(directory, ignore_errors=True)


def install(bundle, *, expected_id=None):
    packages = _root() / "packages"
    packages.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=packages, prefix=".stage-") as stage:
        root = Path(stage) / "files"
        root.mkdir()
        manifest = mod_bundle.stage(bundle, root)
        ident = manifest["id"]
        if expected_id is not None and (ident != expected_id or manifest["kind"] != "integration" or manifest["version"] != "1.0.0"):
            raise ValueError("Official release identity mismatch")
        with _lock:
            old = _read(ident)
            record = {"manifest": manifest, "package": uuid.uuid4().hex, "enabled": False}
            directory = _directory(record)
            root.rename(directory)
            _retiring.add(ident)
            try:
                if old and manifest["kind"] == "integration" and (old["enabled"] or old.get("runtimeError")):
                    _stop(old, updating=True)
                    if old["enabled"]:
                        record = _enable(record, fallback=old)
                    else:
                        _save(record)
                else:
                    record["enabled"] = bool(old and old["enabled"])
                    _save(record)
            except Exception:
                if "stop unconfirmed" not in ((_read(ident) or {}).get("runtimeError") or ""):
                    shutil.rmtree(directory, ignore_errors=True)
                raise
            finally:
                _retiring.discard(ident)
                if old and ident == "momo.qq" and integration_root(ident):
                    from .social import social
                    social._refresh()
            if old:
                shutil.rmtree(_directory(old), ignore_errors=True)
            return _public(record)


def set_enabled(ident, enabled):
    if type(enabled) is not bool:
        raise ValueError("Expected boolean enabled")
    with _lock:
        record = _read(ident)
        if not record:
            raise KeyError(ident)
        if record["enabled"] == enabled and not record.get("runtimeError"):
            return _public(record)
        if record["manifest"]["kind"] == "integration":
            if record.get("runtimeError"):
                record = _stop(record)
            if enabled:
                record = _enable(record)
                if ident == "momo.qq":
                    from .social import social
                    social._refresh()
            elif record["enabled"]:
                record = _stop(record)
        else:
            record["enabled"] = enabled
            _save(record)
        return _public(record)


def uninstall(ident):
    with _lock:
        record = _read(ident)
        if not record:
            raise KeyError(ident)
        if record["manifest"]["kind"] == "integration" and (record["enabled"] or record.get("runtimeError")):
            _stop(record)
        if ident == "momo.qq":
            private = state.DATA_DIR.resolve() / "mod-data" / ident
            cache = private / "resources"
            if private.resolve() == private and cache.exists() and not cache.is_symlink():
                shutil.rmtree(cache)
        _record_path(ident).unlink()
        shutil.rmtree(_directory(record), ignore_errors=True)
        return {"ok": True}


def asset(ident, path, version=None):
    with _lock:
        record = _read(ident)
        if record and record["enabled"] and (not version or record["package"] == version):
            for resource in record["manifest"].get("resources", []):
                if resource["path"] == path:
                    target = _directory(record) / path
                    if target.resolve() != target.absolute():
                        break
                    return target.read_bytes(), mod_bundle.MEDIA[resource["type"]][target.suffix.lower()]
        raise KeyError(path)


def install_official(ident):
    if ident not in mod_bundle.OFFICIAL:
        raise KeyError(ident)
    url = f"https://github.com/Momoyeyu/momo-plugin/releases/download/v1.0.0/{ident}-1.0.0.momomod"
    with tempfile.TemporaryFile() as bundle:
        try:
            with httpx.stream("GET", url, follow_redirects=True, timeout=60) as response:
                response.raise_for_status()
                for chunk in response.iter_bytes(1024 * 1024):
                    if bundle.tell() + len(chunk) > mod_bundle.MAX_BUNDLE:
                        raise ValueError("Official release exceeds size limit")
                    bundle.write(chunk)
        except httpx.HTTPError as error:
            raise ModRuntimeError("Official release download failed. Retry or import the signed package locally.") from error
        return install(bundle, expected_id=ident)
