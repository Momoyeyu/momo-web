"""Build-time offline resource gate. Never invoked by the application at runtime.

Run source preparation scripts first, then:
  python scripts/package_resources.py --verify
  python scripts/package_resources.py --output ../dist/momo-resources.zip
  python scripts/package_resources.py --verify-archive ../dist/momo-resources.zip

Unpack the ZIP at the installer's resource directory and set MOMO_RESOURCES_DIR
there. Every standard installer must include BOTH components; this archive is
installer input, not an optional player download. Native installers are separate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import os
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
COMPONENTS = ("asr", "embedding/multilingual-e5-small")


class ResourceError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _safe_path(value: str) -> str:
    path = PurePosixPath(value)
    if not value or path.is_absolute() or ".." in path.parts or "\\" in value:
        raise ResourceError(f"Unsafe resource path: {value}")
    return path.as_posix()


def collect_resources(backend: Path = ROOT, resources_dir: Path | None = None) -> dict[str, Path]:
    """Resolve and fully verify pinned manifests; missing either component fails."""
    resources = resources_dir or backend / "resources"
    result: dict[str, Path] = {}
    for component in COMPONENTS:
        metadata_dir = resources / component
        manifest_path = metadata_dir / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text())
            entries = manifest["files"]
            if not entries:
                raise ResourceError(f"Empty resource manifest: {manifest_path}")
        except (OSError, ValueError, KeyError) as exc:
            raise ResourceError(f"Missing/invalid resource manifest: {manifest_path}") from exc
        result[f"{component}/manifest.json"] = manifest_path
        for entry in entries:
            relative = _safe_path(entry["path"])
            logical = f"{component}/{relative}"
            if logical in result:
                raise ResourceError(f"Duplicate resource: {logical}")
            source = metadata_dir / relative
            if component == "asr" and resources_dir is None and not source.is_file():
                source = backend / "models" / "asr" / relative
            if not source.is_file():
                raise ResourceError(f"Missing bundled resource: {logical}")
            if source.stat().st_size != entry["size_bytes"] or sha256(source) != entry["sha256"]:
                raise ResourceError(f"Corrupt bundled resource: {logical}")
            result[logical] = source
    return result


def build_archive(output: Path, backend: Path = ROOT, resources_dir: Path | None = None) -> dict:
    files = collect_resources(backend, resources_dir)
    manifest = {
        "format_version": 1,
        "components": list(COMPONENTS),
        "files": [{"path": name, "size_bytes": path.stat().st_size, "sha256": sha256(path)}
                  for name, path in sorted(files.items())],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".part")
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name, path in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                with archive.open(info, "w", force_zip64=True) as dest, path.open("rb") as src:
                    while chunk := src.read(1024 * 1024):
                        dest.write(chunk)
            info = zipfile.ZipInfo("resource-manifest.json", date_time=(2026, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            archive.writestr(info, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        verify_archive(temporary)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return {"path": str(output), "size_bytes": output.stat().st_size, "sha256": sha256(output),
            "uncompressed_bytes": sum(e["size_bytes"] for e in manifest["files"])}


def verify_archive(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("resource-manifest.json"))
        if manifest.get("format_version") != 1 or manifest.get("components") != list(COMPONENTS):
            raise ResourceError("Offline bundle must contain ASR and embedding resources")
        expected = {entry["path"] for entry in manifest["files"]} | {"resource-manifest.json"}
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != expected:
            raise ResourceError("Unexpected or duplicate archive members")
        for entry in manifest["files"]:
            name = _safe_path(entry["path"])
            with archive.open(name) as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if archive.getinfo(name).file_size != entry["size_bytes"] or digest != entry["sha256"]:
                raise ResourceError(f"Corrupt archive resource: {name}")
        # Validate against the included component manifests too, rather than
        # accepting an archive inventory that silently omitted a model/license.
        indexed = {entry["path"]: entry for entry in manifest["files"]}
        for component in COMPONENTS:
            component_manifest = json.loads(archive.read(f"{component}/manifest.json"))
            if not component_manifest.get("files"):
                raise ResourceError(f"Empty component: {component}")
            for entry in component_manifest["files"]:
                key = f"{component}/{_safe_path(entry['path'])}"
                if key not in indexed or any(indexed[key][field] != entry[field] for field in ("sha256", "size_bytes")):
                    raise ResourceError(f"Incomplete archive component: {key}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Verify all source resources without building")
    parser.add_argument("--resources-dir", type=Path, help="Verify/build an extracted install resource root")
    parser.add_argument("--verify-archive", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT.parent / "dist" / "momo-resources.zip")
    args = parser.parse_args()
    try:
        if args.verify_archive:
            verify_archive(args.verify_archive)
            print(f"Verified offline bundle: {args.verify_archive}")
        elif args.verify:
            print(f"Verified {len(collect_resources(resources_dir=args.resources_dir))} bundled files (ASR + embedding)")
        else:
            print(json.dumps(build_archive(args.output, resources_dir=args.resources_dir), indent=2))
    except (ResourceError, OSError, ValueError, KeyError, zipfile.BadZipFile) as exc:
        print(f"Resource build failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
