"""Inert resource fixtures: these tests never load QQ or execute a vendor file."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil

import pytest

spec = importlib.util.spec_from_file_location("prepare_qq_runtime", Path(__file__).with_name("prepare-qq-runtime.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


@pytest.fixture
def package(tmp_path):
    root = tmp_path.resolve() / "source"
    root.mkdir(mode=0o700)
    pins = {"resourceId": "momo-qq-fixture", "version": "fixture-1", "platform": "darwin", "architecture": "arm64",
            "nativeABI": {"electron": "37.1.0", "node": "22.16.0", "modules": "136", "napi": "10"},
            "qq": {"version": "6.9.95", "buildVersion": "48517"}}
    roles = {"runtime": "QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A/QQNT",
             "major": "QQRuntime.app/Contents/Resources/app/major.node", "wrapper": "QQRuntime.app/Contents/Resources/app/wrapper.node",
             "bootstrap": "QQRuntime.app/Contents/MacOS/MomoQQRuntime", "worker": "old/worker.cjs",
             "profile": "old/isolation.sb", "metadata": "old/metadata.json"}
    files = {path: f"inert fixture: {role}\n".encode() for role, path in roles.items()}
    files[roles["metadata"]] = json.dumps(pins).encode()
    files["QQRuntime.app/Contents/Info.plist"] = b"old original bundle metadata"
    files["QQRuntime.app/Contents/Frameworks/QtCore.framework/Versions/A/QtCore"] = b"inert dependency"
    entries = []
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(content)
        path.chmod(0o600)
        entries.append({"path": name, "sha256": hashlib.sha256(content).hexdigest()})
    link = "QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current"
    (root / link).symlink_to("A", target_is_directory=True)
    entries.append({"path": link, "symlink": "A"})
    manifest = {"schemaVersion": 1, **pins, "roles": roles, "entries": entries, "dependencyClosure": [entry["path"] for entry in entries]}
    source_manifest = tmp_path.resolve() / "source-manifest.json"
    source_manifest.write_text(json.dumps(manifest))
    source_manifest.chmod(0o600)
    sdk = tmp_path.resolve() / "SDK"
    sdk.mkdir(mode=0o700)
    return root, source_manifest, manifest, sdk


def args(package, destination):
    root, manifest, _, sdk = package
    return dict(source_package=root, source_manifest=manifest, destination=destination,
                sdk_path=sdk, node=Path(shutil.which("node")), clang=Path("/usr/bin/clang"))


def test_stages_verified_vendor_bytes_and_only_original_controls(package, tmp_path, monkeypatch):
    destination = tmp_path.resolve() / "new-runtime"
    calls = []

    def compile_fixture(*, output, **_):
        calls.append(output)
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        output.write_bytes(b"original inert launcher fixture")
        output.chmod(0o700)

    monkeypatch.setattr(stage, "compile_launcher", compile_fixture)
    result = stage.prepare(**args(package, destination))
    assert result == destination / "runtime-config.json"
    assert len(calls) == 1
    config = json.loads(result.read_text())
    assert set(config) == {"privateRoot", "resourceRoot", "manifestPath", "dataRoot", "controlRoot", "canaryPath"}
    resources = Path(config["resourceRoot"])
    assert not (resources / "old").exists()
    assert (resources / "control/worker.cjs").read_bytes() == (stage.REPO / "plugin-host/src/qq-native-worker.cjs").read_bytes()
    assert (resources / "QQRuntime.app/Contents/Resources/app/wrapper.node").read_bytes() == b"inert fixture: wrapper\n"
    assert os.readlink(resources / "QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current") == "A"
    for path in (destination, resources, Path(config["dataRoot"]), Path(config["controlRoot"])):
        assert path.stat().st_mode & 0o777 == 0o700
    for path in (result, Path(config["manifestPath"]), Path(config["canaryPath"])):
        assert path.stat().st_mode & 0o777 == 0o600
    stage.qualify(resources, json.loads(Path(config["manifestPath"]).read_text()), Path(shutil.which("node")))


def test_bad_source_manifest_refuses_before_copy_or_compile(package, tmp_path, monkeypatch):
    _, source_manifest, manifest, _ = package
    manifest["entries"][0]["sha256"] = "0" * 64
    source_manifest.write_text(json.dumps(manifest))
    monkeypatch.setattr(stage, "compile_launcher", lambda **_: pytest.fail("compiler must not run"))
    destination = tmp_path.resolve() / "new-runtime"
    with pytest.raises(stage.PreparationError, match="qualification"):
        stage.prepare(**args(package, destination))
    assert not destination.exists()


def test_existing_destination_and_symlink_are_never_overwritten(package, tmp_path, monkeypatch):
    monkeypatch.setattr(stage, "compile_launcher", lambda **_: pytest.fail("compiler must not run"))
    destination = tmp_path.resolve() / "existing"
    destination.mkdir(mode=0o700)
    marker = destination / "account-session"
    marker.write_text("must remain")
    for path in (destination, tmp_path.resolve() / "alias"):
        if path != destination:
            path.symlink_to(destination, target_is_directory=True)
        with pytest.raises(stage.PreparationError):
            stage.prepare(**args(package, path))
        assert marker.read_text() == "must remain"


def test_compile_failure_removes_only_the_new_owned_destination(package, tmp_path, monkeypatch):
    def fail(**_):
        raise stage.PreparationError("compiler unavailable")
    monkeypatch.setattr(stage, "compile_launcher", fail)
    destination = tmp_path.resolve() / "failed-runtime"
    with pytest.raises(stage.PreparationError, match="compiler unavailable"):
        stage.prepare(**args(package, destination))
    assert not destination.exists()
    assert package[0].exists()


def test_destination_inside_git_checkout_is_rejected(package, tmp_path):
    checkout = tmp_path.resolve() / "checkout"
    checkout.mkdir(mode=0o700)
    (checkout / ".git").mkdir()
    with pytest.raises(stage.PreparationError, match="Git checkout"):
        stage.prepare(**args(package, checkout / "resources"))
