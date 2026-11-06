"""Release resource gate uses tiny fixtures, never downloads or player data."""
import hashlib
import importlib.util
import json
from pathlib import Path
import zipfile

import pytest

_spec = importlib.util.spec_from_file_location("package_resources", Path(__file__).resolve().parents[1] / "scripts/package_resources.py")
pack = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pack)


def fixture_resources(tmp_path):
    backend = tmp_path / "backend"
    for component in pack.COMPONENTS:
        root = backend / "resources" / component
        root.mkdir(parents=True)
        files = []
        for name in ("model.onnx", "LICENSE"):
            content = f"{component}/{name}".encode()
            (root / name).write_bytes(content)
            files.append({"path": name, "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
        (root / "manifest.json").write_text(json.dumps({"files": files}))
    return backend


def test_offline_bundle_is_reproducible_and_extractable(tmp_path):
    backend = fixture_resources(tmp_path)
    a, b = tmp_path / "a.zip", tmp_path / "b.zip"
    assert pack.build_archive(a, backend)["sha256"] == pack.build_archive(b, backend)["sha256"]
    pack.verify_archive(a)
    with zipfile.ZipFile(a) as archive:
        archive.extractall(tmp_path / "install")
    assert len(pack.collect_resources(resources_dir=tmp_path / "install")) == 6


def test_build_refuses_missing_embedding_and_corrupt_asr(tmp_path):
    backend = fixture_resources(tmp_path)
    model = backend / "resources/asr/model.onnx"
    model.write_bytes(b"corrupt")
    with pytest.raises(pack.ResourceError, match="Corrupt.*asr"):
        pack.build_archive(tmp_path / "bad.zip", backend)
    model.unlink()
    with pytest.raises(pack.ResourceError, match="Missing.*asr"):
        pack.collect_resources(backend)
    backend = fixture_resources(tmp_path / "another")
    (backend / "resources/embedding/multilingual-e5-small/manifest.json").unlink()
    with pytest.raises(pack.ResourceError, match="manifest.*embedding"):
        pack.build_archive(tmp_path / "bad.zip", backend)
    assert not (tmp_path / "bad.zip").exists()


def test_manifest_rejects_path_traversal(tmp_path):
    backend = fixture_resources(tmp_path)
    path = backend / "resources/asr/manifest.json"
    data = json.loads(path.read_text())
    data["files"][0]["path"] = "../../secret"
    path.write_text(json.dumps(data))
    with pytest.raises(pack.ResourceError, match="Unsafe"):
        pack.collect_resources(backend)


def test_archive_inventory_cannot_omit_component_models(tmp_path):
    backend = fixture_resources(tmp_path)
    output = tmp_path / "good.zip"
    pack.build_archive(output, backend)
    with zipfile.ZipFile(output) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries.pop("embedding/multilingual-e5-small/model.onnx")
    inventory = json.loads(entries["resource-manifest.json"])
    inventory["files"] = [e for e in inventory["files"] if e["path"] != "embedding/multilingual-e5-small/model.onnx"]
    entries["resource-manifest.json"] = json.dumps(inventory).encode()
    with zipfile.ZipFile(tmp_path / "bad.zip", "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    with pytest.raises(pack.ResourceError, match="Incomplete"):
        pack.verify_archive(tmp_path / "bad.zip")


def test_asr_builder_rejects_bad_download_without_replacing_model(tmp_path, monkeypatch):
    import io
    spec = importlib.util.spec_from_file_location("download_asr_models", Path(__file__).resolve().parents[1] / "scripts/download_asr_models.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    target = tmp_path / "model.onnx"
    target.write_bytes(b"previous model")
    monkeypatch.setattr(builder.urllib.request, "urlopen", lambda *a, **kw: io.BytesIO(b"wrong bytes"))
    entry = {"path": "model.onnx", "size_bytes": 11, "sha256": "0" * 64}
    with pytest.raises(ValueError, match="Checksum"):
        builder._download("https://example.test/model", target, entry)
    assert target.read_bytes() == b"previous model"
    assert not target.with_suffix(".onnx.part").exists()
