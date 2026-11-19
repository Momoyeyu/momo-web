"""Validate and stage format-1 local Mod packages. Import never executes package files."""
import base64
import hashlib
import json
import platform
import re
import stat
import sys
import wave
import zipfile
import zlib
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from PIL import Image


OFFICIAL = {"momo.qq": "qq", "momo.minecraft": "minecraft"}
PUBLIC_KEY = "Sv8CXdlNcwQGqAsAkg++MoXizS3tTl3JbRj8q2pWAT4="
MAX_BUNDLE = 1024 * 1024 * 1024
MAX_EXPANDED = 1536 * 1024 * 1024
MAX_CONTENT = 64 * 1024 * 1024
MAX_FILES = 8192
MEDIA = {"background": {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                        ".webp": "image/webp"},
         "bgm": {".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg"}}


def current_platform():
    arch = platform.machine().lower()
    return sys.platform + "-" + {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(arch, arch)


def mod_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*", value) or len(value) > 80:
        raise ValueError("Invalid Mod ID")
    safe_path(value)
    return value


def safe_path(value):
    if not isinstance(value, str) or len(value) > 220:
        raise ValueError("Invalid package path")
    for part in value.split("/"):
        if (not re.fullmatch(r"[a-zA-Z0-9_@+-][a-zA-Z0-9_. @+-]{0,119}", part)
                or part.endswith((".", " ")) or re.fullmatch(r"CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]", part.split(".")[0].rstrip().upper())):
            raise ValueError("Invalid package path")
    return value


def _manifest(data):
    def unique(pairs):
        values = dict(pairs)
        if len(values) != len(pairs):
            raise ValueError("Duplicate manifest key")
        return values

    m = json.loads(data, object_pairs_hook=unique)
    if not isinstance(m, dict):
        raise ValueError("Expected manifest object")
    shared = {"formatVersion", "id", "name", "kind", "version", "momoApi", "platforms", "files"}
    kind = m.get("kind")
    extra = {"resources"} if kind == "content" else {"capabilities", "entrypoints", "signature"}
    if set(m) != shared | extra or type(m["formatVersion"]) is not int or m["formatVersion"] != 1:
        raise ValueError("Unsupported manifest fields or format")
    ident = mod_id(m["id"])
    if not isinstance(m["version"], str) or not re.fullmatch(r"\d{1,6}\.\d{1,6}\.\d{1,6}", m["version"]):
        raise ValueError("Invalid release version")
    if m["momoApi"] not in ("^1.0.0", "1.0.0"):
        raise ValueError("Incompatible momo API")
    if not isinstance(m["name"], str) or not m["name"].strip() or len(m["name"]) > 100:
        raise ValueError("Invalid Mod name")
    platforms = m["platforms"]
    if (not isinstance(platforms, list) or not platforms or any(not isinstance(p, str)
            or not re.fullmatch(r"\*|(?:linux|win32|darwin)-(?:x64|arm64)", p) for p in platforms)
            or not ("*" in platforms or current_platform() in platforms)):
        raise ValueError("Incompatible platform")
    files = m["files"]
    if not isinstance(files, dict) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError("Invalid file inventory")
    for path, digest in files.items():
        safe_path(path)
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid SHA-256 checksum")
    if kind == "content":
        if ident.startswith("momo.") or not isinstance(m["resources"], list) or not m["resources"]:
            raise ValueError("Invalid content manifest")
        declared = []
        for resource in m["resources"]:
            if not isinstance(resource, dict) or set(resource) != {"type", "path"}:
                raise ValueError("Invalid resource")
            path = safe_path(resource["path"])
            if not isinstance(resource["type"], str) or Path(path).suffix.lower() not in MEDIA.get(resource["type"], {}):
                raise ValueError("Unsupported media type")
            declared.append(path)
        if set(declared) != set(files) or len(declared) != len(files):
            raise ValueError("Content package must declare every media file once")
    elif kind == "integration" and ident in OFFICIAL:
        entries = m["entrypoints"]
        if (not isinstance(entries, dict) or set(entries) != set(platforms) or "*" in platforms
                or any(safe_path(entry) not in files or not entry.endswith(".mjs") for entry in entries.values())
                or m["capabilities"] != [OFFICIAL[ident]]):
            raise ValueError("Invalid official entrypoint or capabilities")
        canonical = json.dumps({k: v for k, v in m.items() if k != "signature"},
                               sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        try:
            Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBLIC_KEY, validate=True)).verify(
                base64.b64decode(m["signature"], validate=True), canonical)
        except (InvalidSignature, TypeError, ValueError):
            raise ValueError("Invalid official release signature") from None
    else:
        raise ValueError("Unknown integration")
    return m


def _wav_file(path):
    try:
        with wave.open(str(path), "rb") as audio:
            frames = audio.getnframes()
            if frames <= 0 or audio.getframerate() <= 0:
                raise ValueError()
            audio.setpos(frames - 1)
            if len(audio.readframes(1)) != audio.getsampwidth() * audio.getnchannels():
                raise ValueError()
    except (OSError, EOFError, ValueError, wave.Error):
        raise ValueError("Invalid WAV audio") from None


def _media_file(resource, root):
    path = root / resource["path"]
    if resource["type"] == "background":
        try:
            with Image.open(path) as img:
                if img.width * img.height > 32_000_000 or Image.MIME.get(img.format) != MEDIA["background"][path.suffix.lower()]:
                    raise ValueError()
                img.verify()
        except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
            raise ValueError("Invalid background image") from None
    else:
        with path.open("rb") as stream:
            head = stream.read(12)
        valid = {".ogg": head.startswith(b"OggS"), ".wav": head.startswith(b"RIFF") and head[8:12] == b"WAVE",
                 ".mp3": head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 255 and head[1] & 224 == 224)}
        if not valid[path.suffix.lower()]:
            raise ValueError("Invalid BGM format")
        if path.suffix.lower() == ".wav":
            _wav_file(path)


def stage(bundle, root):
    try:
        bundle.seek(0, 2)
        if bundle.tell() > MAX_BUNDLE:
            raise ValueError("Package exceeds size limit")
        # Bound central directory memory before ZipFile materializes every entry.
        end = zipfile._EndRecData(bundle)
        if not end or end[4] > MAX_FILES + 1 or end[5] > 4 * 1024 * 1024:
            raise ValueError("Invalid ZIP directory or too many entries")
        with zipfile.ZipFile(bundle) as archive:
            infos = archive.infolist()
            paths = {}
            names = set()
            total = 0
            for info in infos:
                name = safe_path(info.orig_filename.removesuffix("/") if info.is_dir() else info.orig_filename)
                mode = stat.S_IFMT(info.external_attr >> 16)
                if (name in names or mode not in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG)
                        or info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        or (info.is_dir() and info.file_size)):
                    raise ValueError("Invalid ZIP entry")
                names.add(name)
                parts = name.split("/")
                for i in range(1, len(parts) + 1):
                    prefix = "/".join(parts[:i])
                    expected = (prefix, i < len(parts) or info.is_dir())
                    if paths.setdefault(prefix.lower(), expected) != expected:
                        raise ValueError("Conflicting ZIP paths")
                total += info.file_size
            if len(infos) > MAX_FILES + 1 or total > MAX_EXPANDED or archive.getinfo("manifest.json").file_size > 2**20:
                raise ValueError("Package exceeds extraction limits")
            manifest = _manifest(archive.read("manifest.json"))
            if {f.filename for f in infos if not f.is_dir()} != set(manifest["files"]) | {"manifest.json"} or "manifest.json" in manifest["files"]:
                raise ValueError("Archive inventory mismatch")
            if manifest["kind"] == "content" and total > MAX_CONTENT:
                raise ValueError("Content exceeds extraction limit")
            for name, expected in manifest["files"].items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                with archive.open(name) as src, target.open("xb") as dest:
                    while chunk := src.read(1024 * 1024):
                        digest.update(chunk)
                        dest.write(chunk)
                if digest.hexdigest() != expected:
                    raise ValueError("File checksum mismatch")
            for resource in manifest.get("resources", []):
                _media_file(resource, root)
            return manifest
    except (KeyError, zipfile.BadZipFile, NotADirectoryError, FileExistsError, EOFError, RecursionError, zlib.error) as exc:
        raise ValueError("Invalid Mod archive") from exc
