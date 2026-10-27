#!/usr/bin/env python3
"""Stage an explicitly supplied, reviewed QQ closure; never run vendor code.

This developer utility does not download/extract QQ, scan installed applications,
modify a source package, or grant distribution rights for third-party resources.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import subprocess
import sys

REPO = Path(__file__).resolve().parents[1]
PIN_KEYS = ("resourceId", "version", "platform", "architecture", "nativeABI", "qq")
ROLES = {
    "runtime": "QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A/QQNT",
    "major": "QQRuntime.app/Contents/Resources/app/major.node",
    "wrapper": "QQRuntime.app/Contents/Resources/app/wrapper.node",
    "bootstrap": "QQRuntime.app/Contents/MacOS/MomoQQRuntime",
    "worker": "control/worker.cjs", "profile": "control/isolation.sb", "metadata": "control/metadata.json",
}
VENDOR_PREFIXES = ("QQRuntime.app/Contents/Frameworks/", "QQRuntime.app/Contents/Resources/")


class PreparationError(ValueError):
    pass


def canonical(path, *, exists=True):
    path = Path(path)
    if (not path.is_absolute() or len(str(path)) > 4096 or any(ord(char) < 32 or ord(char) == 127 for char in str(path))
            or path != path.resolve(strict=exists)):
        raise PreparationError("Use an absolute canonical path without symbolic-link parents")
    return path


def read_manifest(path):
    path = canonical(path)
    with path.open("rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > 4 * 1024 * 1024):
            raise PreparationError("The reviewed source manifest must be an owned, protected regular file")
        return json.loads(stream.read())


def qualify(root, manifest, node):
    # The existing production qualifier is the authority for the complete source
    # inventory, hashes, internal links, ownership, and ABI metadata. No resource
    # executable or package entrypoint is ever used as a validator.
    script = """import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const {qualifyQQResources}=await import(pathToFileURL(process.argv[1]));
await qualifyQQResources({root:process.argv[2],manifest:JSON.parse(readFileSync(0,'utf8'))});
"""
    result = subprocess.run([str(node), "--input-type=module", "--eval", script,
                             str(REPO / "plugin-host/src/qq-resources.mjs"), str(root)],
                            input=json.dumps(manifest), text=True, capture_output=True, timeout=180, check=False)
    if result.returncode:
        raise PreparationError("QQ resource qualification failed; source bytes and reviewed pins must agree")


def parent_fd(root_fd, relative):
    current = os.dup(root_fd)
    try:
        for part in Path(relative).parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def snapshot(info):
    return tuple(getattr(info, key) for key in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns", "st_mode", "st_uid", "st_nlink"))


def copy_closure(source, resources, manifest):
    root_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Links are created after regular files. Never follow a source link while
        # opening a canonical file, even if the source changes after qualification.
        for entry in manifest["entries"]:
            if "sha256" not in entry:
                continue
            relative = entry["path"]
            output = resources / relative
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            parent = parent_fd(root_fd, relative)
            try:
                descriptor = os.open(Path(relative).name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                with os.fdopen(descriptor, "rb") as reader, output.open("xb") as writer:
                    before = os.fstat(reader.fileno())
                    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                            or before.st_nlink != 1 or before.st_mode & 0o022):
                        raise PreparationError("Source resource changed during staging")
                    digest = hashlib.sha256()
                    while chunk := reader.read(1024 * 1024):
                        digest.update(chunk)
                        writer.write(chunk)
                    if digest.hexdigest() != entry["sha256"] or snapshot(before) != snapshot(os.fstat(reader.fileno())):
                        raise PreparationError("Source resource changed during staging")
                    os.fchmod(writer.fileno(), stat.S_IMODE(before.st_mode) & 0o700)
            finally:
                os.close(parent)
        for entry in manifest["entries"]:
            if "symlink" not in entry:
                continue
            relative = entry["path"]
            parent = parent_fd(root_fd, relative)
            try:
                if os.readlink(Path(relative).name, dir_fd=parent) != entry["symlink"]:
                    raise PreparationError("Source link changed during staging")
            finally:
                os.close(parent)
            output = resources / relative
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            output.symlink_to(entry["symlink"])
    finally:
        os.close(root_fd)


def write_private(path, content, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as output:
        os.fchmod(output.fileno(), mode)
        output.write(content)


def compile_launcher(*, output, sdk_path, clang):
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    result = subprocess.run([str(clang), "-isysroot", str(sdk_path),
                             str(REPO / "plugin-host/native/macos/launcher.m"), "-framework", "Foundation", "-o", str(output)],
                            text=True, capture_output=True, timeout=120, check=False)
    if result.returncode or not output.is_file() or output.is_symlink():
        raise PreparationError("Could not build the original launcher; check the selected clang and --sdk-path")
    output.chmod(0o700)


def inventory(resources):
    entries = []
    for directory, dirs, files in os.walk(resources, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            relative = path.relative_to(resources).as_posix()
            if path.is_symlink():
                entries.append({"path": relative, "symlink": os.readlink(path)})
            elif path.is_file():
                with path.open("rb") as source:
                    digest = hashlib.sha256()
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                    entries.append({"path": relative, "sha256": digest.hexdigest()})
    return sorted(entries, key=lambda entry: entry["path"])


def prepare(*, source_package, source_manifest, destination, sdk_path, node, clang):
    source = canonical(source_package)
    destination = canonical(destination, exists=False)
    parent = canonical(destination.parent)
    sdk_path = canonical(sdk_path)
    node = Path(node).resolve(strict=True)
    clang = Path(clang)
    if source.parts[:2] in (("/", "Applications"), ("/", "System")):
        raise PreparationError("Use a curated resource package, not an installed QQ application")
    if source == destination or source in destination.parents or destination in source.parents:
        raise PreparationError("Source and destination must be separate")
    if os.path.lexists(destination):
        raise PreparationError("Destination already exists; existing resources or account sessions are never overwritten")
    if any(os.path.lexists(ancestor / ".git") for ancestor in (parent, *parent.parents)):
        raise PreparationError("Destination must be outside a Git checkout")
    parent_info = parent.stat()
    if not parent.is_dir() or parent_info.st_uid != os.getuid() or parent_info.st_mode & 0o022:
        raise PreparationError("Destination parent must be an owned directory without group or public write access")
    if (not sdk_path.is_dir() or not clang.is_absolute() or node == source or source in node.parents
            or clang == source or source in clang.resolve(strict=False).parents):
        raise PreparationError("Select developer tools and an explicit SDK outside the vendor resource package")
    manifest = read_manifest(source_manifest)
    qualify(source, manifest, node)
    if (manifest["qq"] != {"version": "6.9.95", "buildVersion": "48517"}
            or manifest["nativeABI"] != {"electron": "37.1.0", "node": "22.16.0", "modules": "136", "napi": "10"}):
        raise PreparationError("Only the currently reviewed QQ 6.9.95-48517 native ABI is supported")
    pins = {key: manifest[key] for key in PIN_KEYS}
    destination.mkdir(mode=0o700)
    created = destination.stat()
    try:
        resources = destination / "resources"
        resources.mkdir(mode=0o700)
        copy_closure(source, resources, manifest)
        qualify(resources, manifest, node)
        # First verify the unchanged copied closure, then retain only its vendor
        # subtree. The old bootstrap/control code and bundle plist are replaced
        # with this repository's originals; vendor bytes remain unchanged.
        for entry in manifest["entries"]:
            if not entry["path"].startswith(VENDOR_PREFIXES):
                (resources / entry["path"]).unlink()
        for directory, _, _ in os.walk(resources, topdown=False, followlinks=False):
            path = Path(directory)
            if path != resources and not path.is_symlink() and not any(path.iterdir()):
                path.rmdir()
        write_private(resources / ROLES["worker"], (REPO / "plugin-host/src/qq-native-worker.cjs").read_bytes())
        write_private(resources / ROLES["profile"], (REPO / "plugin-host/native/macos/isolation.sb").read_bytes())
        write_private(resources / ROLES["metadata"], json.dumps(pins, indent=2).encode())
        info = {"CFBundleExecutable": "MomoQQRuntime", "CFBundleIdentifier": "dev.momo.qq.runtime", "CFBundleName": "QQRuntime",
                "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "0.1.0", "CFBundleVersion": "1", "LSUIElement": True}
        write_private(resources / "QQRuntime.app/Contents/Info.plist", plistlib.dumps(info))
        compile_launcher(output=resources / ROLES["bootstrap"], sdk_path=sdk_path, clang=clang)
        entries = inventory(resources)
        prepared = {"schemaVersion": 1, **pins, "roles": ROLES, "entries": entries,
                    "dependencyClosure": [entry["path"] for entry in entries]}
        qualify(resources, prepared, node)
        manifest_path = destination / "manifest.json"
        write_private(manifest_path, json.dumps(prepared, indent=2).encode())
        data, control = destination / "data", destination / "runtime-control"
        data.mkdir(mode=0o700)
        control.mkdir(mode=0o700)
        canary = destination / "barrier-canary"
        write_private(canary, b"momo-private-barrier-check\n")
        config = {"privateRoot": str(destination), "resourceRoot": str(resources), "manifestPath": str(manifest_path),
                  "dataRoot": str(data), "controlRoot": str(control), "canaryPath": str(canary)}
        config_path = destination / "runtime-config.json"
        write_private(config_path, json.dumps(config, indent=2).encode())
        return config_path
    except BaseException:
        # Never delete a pre-existing or replaced directory while handling failure.
        if not destination.is_symlink() and destination.exists():
            current = destination.stat()
            if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                shutil.rmtree(destination)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-package", required=True, type=Path, help="Canonical private package root with the reviewed native closure")
    parser.add_argument("--source-manifest", required=True, type=Path, help="Reviewed schemaVersion=1 resource manifest; not package-supplied trust")
    parser.add_argument("--destination", required=True, type=Path, help="New canonical private directory outside a Git checkout; never overwritten")
    parser.add_argument("--sdk-path", required=True, type=Path, help="Explicit macOS SDK directory for building only the original launcher")
    parser.add_argument("--node", type=Path, default=Path(shutil.which("node") or "/usr/local/bin/node"), help="Developer Node executable used only for offline qualification")
    parser.add_argument("--clang", type=Path, default=Path("/usr/bin/clang"), help="Developer clang executable, outside the source resource package")
    try:
        result = prepare(**vars(parser.parse_args()))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, PreparationError) else "Resource preparation failed; check explicit input paths and developer tools"
        parser.exit(1, message + "\n")
    print(json.dumps({"configPath": str(result), "runtimeStarted": False}))


if __name__ == "__main__":
    main()
