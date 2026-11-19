import base64
import hashlib
import io
import json
import threading
import zipfile
from contextlib import contextmanager

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from PIL import Image
import pytest

from app.main import app
from app.services import activities, mod_bundle, mods, phone
from app.services.coordinator import runtime

client = TestClient(app)


def image():
    out = io.BytesIO()
    Image.new("RGB", (2, 3), (40, 60, 80)).save(out, "PNG")
    return out.getvalue()


def package(*, ident="artist.evening", version="1.0.0", files=None, key=None, **changes):
    files = {"images/evening.png": image()} if files is None else files
    manifest = {"formatVersion": 1, "id": ident, "name": "Evening", "version": version,
                "momoApi": "^1.0.0", "kind": "content", "platforms": ["*"],
                "files": {p: hashlib.sha256(data).hexdigest() for p, data in files.items()},
                "resources": [{"type": "background", "path": p} for p in files]}
    if key:
        del manifest["resources"]
        host = mod_bundle.current_platform()
        manifest.update(kind="integration", capabilities=[mod_bundle.OFFICIAL[ident]],
                        platforms=[host], entrypoints={host: "entry.mjs"})
    manifest.update(changes)
    if key:
        canonical = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        manifest["signature"] = base64.b64encode(key.sign(canonical)).decode()
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for p, data in files.items():
            archive.writestr(p, data)
    return out


def test_content_lifecycle_and_http_assets():
    bundle = package()
    response = client.post("/api/mods", files={"file": ("test.momomod", bundle.getvalue())})
    assert response.status_code == 200, response.text
    record = response.json()
    url = record["resources"][0]["url"]
    assert record["source"] == "local" and not record["enabled"]
    assert client.get(url).status_code == 404
    assert client.patch("/api/mods/artist.evening", json={"enabled": True}).json()["enabled"]
    assert client.get(url).content == image()
    assert client.get(url).headers["content-type"] == "image/png"
    new = mods.install(package(version="1.1.0"))
    assert new["enabled"]
    assert client.get(url).status_code == 404
    assert client.get(new["resources"][0]["url"]).content == image()
    rolled_back = mods.install(package())
    assert rolled_back["enabled"] and rolled_back["version"] == "1.0.0"
    assert client.patch("/api/mods/artist.evening", json={"enabled": False}).is_success
    assert client.get(rolled_back["resources"][0]["url"]).status_code == 404
    assert client.delete("/api/mods/artist.evening").is_success
    assert client.get("/api/mods").json() == {"mods": []}


@pytest.mark.parametrize("case", ["platform", "api", "digest", "content-code", "reserved",
                                  "traversal", "windows", "limit", "media", "casefold", "malformed"])
def test_invalid_update_preserves_active_version(case, monkeypatch):
    mods.install(package())
    mods.set_enabled("artist.evening", True)
    kwargs = {"version": "2.0.0"}
    if case == "platform":
        monkeypatch.setattr(mod_bundle, "current_platform", lambda: "darwin-arm64")
        kwargs["platforms"] = ["linux-x64"]
    elif case == "api":
        kwargs["momoApi"] = "^4.0.0"
    elif case == "digest":
        bundle = package(**kwargs)
        with zipfile.ZipFile(bundle) as z:
            data = json.loads(z.read("manifest.json"))
        data["files"]["images/evening.png"] = "0" * 64
        bundle = io.BytesIO()
        with zipfile.ZipFile(bundle, "w") as z:
            z.writestr("manifest.json", json.dumps(data))
            z.writestr("images/evening.png", image())
    elif case == "reserved":
        kwargs["ident"] = "momo.qq"
    elif case in {"content-code", "traversal", "windows", "media"}:
        path = {"content-code": "run.mjs", "traversal": "../outside.png", "windows": "LPT1.png", "media": "fake.png"}[case]
        kwargs["files"] = {path: b"fixture"}
    elif case == "limit":
        monkeypatch.setattr(mod_bundle, "MAX_CONTENT", 10)
    elif case == "casefold":
        kwargs["files"] = {"a.png": image(), "A.png": image()}
    elif case == "malformed":
        bundle = io.BytesIO(b"broken")
    if case not in {"digest", "malformed"}:
        bundle = package(**kwargs)
    with pytest.raises(ValueError):
        mods.install(bundle)
    assert [(r["id"], r["version"], r["enabled"]) for r in mods.listing()] == [("artist.evening", "1.0.0", True)]


class Host:
    control = threading.RLock()

    def __init__(self):
        self.calls = []
        self.reject_stop = False

    def request(self, method, params, **kwargs):
        assert method == "mods.configure"
        self.calls.append(params)
        enabled = params["binding"] is not None
        if not enabled and self.reject_stop:
            raise RuntimeError("Unconfirmed")
        return {"id": params["id"], "enabled": enabled, "stopped": not enabled}


@pytest.fixture
def integration(monkeypatch):
    signer = Ed25519PrivateKey.generate()
    monkeypatch.setattr(mod_bundle, "PUBLIC_KEY", base64.b64encode(signer.public_key().public_bytes_raw()).decode())
    host = Host()
    monkeypatch.setattr(runtime, "host", host)

    def build(ident="momo.minecraft", **fields):
        return package(ident=ident, files={"entry.mjs": b"export default 0"}, key=signer, **fields)
    return host, build


def test_official_signature_and_independent_stop(integration, tmp_path):
    host, build = integration
    with pytest.raises(ValueError, match="signature"):
        mods.install(package(ident="momo.qq", files={"entry.mjs": b""}, key=Ed25519PrivateKey.generate()))
    for ident in ("momo.minecraft", "momo.qq"):
        assert not mods.install(build(ident))["enabled"]
    assert host.calls == [] and not activities.snapshot()["enabled"]["minecraft"]
    for ident in ("momo.minecraft", "momo.qq"):
        mods.set_enabled(ident, True)
    assert activities.snapshot()["enabled"]["minecraft"]
    private = tmp_path / "mod-data/momo.minecraft/state"
    private.write_text("keep")
    host.reject_stop = True
    with pytest.raises(mods.ModRuntimeError, match="stop unconfirmed"):
        mods.uninstall("momo.minecraft")
    assert not mods.integration_root("momo.minecraft") and mods.integration_root("momo.qq")
    assert mods.listing()[0]["runtimeError"]
    host.reject_stop = False
    mods.uninstall("momo.minecraft")
    assert mods.integration_root("momo.qq") and private.read_text() == "keep"


def test_restart_revalidates_executable_and_preserves_core(integration):
    host, build = integration
    mods.install(build())
    mods.set_enabled("momo.minecraft", True)
    restarted = Host()
    mods.restore(restarted)
    assert restarted.calls[0]["binding"]
    (mods.integration_root("momo.minecraft") / "entry.mjs").write_bytes(b"changed")
    mods.restore(restarted)
    assert not mods.integration_root("momo.minecraft")
    assert "checksum" in mods.listing()[0]["runtimeError"]
    assert restarted.calls[-1]["binding"] is None


def test_failed_upgrade_restores_previous_binding(integration, monkeypatch):
    host, build = integration
    mods.install(build())
    mods.set_enabled("momo.minecraft", True)
    old = mods.integration_root("momo.minecraft")
    original = host.request
    def fail_candidate(method, params, **kwargs):
        if params["binding"] and params["binding"]["modRoot"] != str(old):
            raise RuntimeError("bad release")
        return original(method, params, **kwargs)
    monkeypatch.setattr(host, "request", fail_candidate)
    with pytest.raises(mods.ModRuntimeError):
        mods.install(build(version="1.1.0"))
    assert mods.integration_root("momo.minecraft") == old
    assert host.calls[-1]["binding"]["modRoot"] == str(old)


def test_fixed_official_catalog_checks_download_identity(integration, monkeypatch):
    _, build = integration
    payload = build("momo.qq").getvalue()
    @contextmanager
    def stream(method, url, **kwargs):
        assert method == "GET" and url.endswith("/momo.minecraft-1.0.0.momomod")
        class Response:
            def raise_for_status(self): pass
            def iter_bytes(self, size): yield payload
        yield Response()
    monkeypatch.setattr(mods.httpx, "stream", stream)
    assert client.post("/api/mods/official/momo.minecraft").status_code == 400
    assert client.post("/api/mods/official/arbitrary").status_code == 404
    payload = build().getvalue()
    assert client.post("/api/mods/official/momo.minecraft").json()["enabled"] is False


def test_clean_profile_hides_phone_and_game(monkeypatch):
    monkeypatch.setattr(phone.social, "get", lambda p: {"enabled": True})
    assert phone.snapshot()["apps"] == []
    assert client.get("/api/minecraft/status").json() == {"available": False, "active": False}
    assert client.get("/api/minecraft/sessions").status_code == 409


def test_example_bundle_serves_decodable_original_audio_after_restart(tmp_path):
    import wave
    from pathlib import Path
    from app.services import archive
    example = Path(__file__).resolve().parents[2] / "docs/examples/evening-chimes.momomod"
    with example.open("rb") as src:
        record = mods.install(src)
    mods.set_enabled(record["id"], True)
    mods.restore(Host())
    response = client.get(record["resources"][0]["url"])
    assert response.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(response.content)) as song:
        assert song.getnframes() / song.getframerate() == 6 and song.getnchannels() == 1
        assert any(song.readframes(song.getnframes()))
    private = tmp_path / "mod-data/example.evening-chimes/preferences"
    private.parent.mkdir(parents=True)
    private.write_text("retained")
    snapshot = archive.export_data()
    with zipfile.ZipFile(io.BytesIO(snapshot)) as data:
        assert not any(name.startswith(("mods/", "mod-data/")) for name in data.namelist())
    archive.import_data(snapshot)
    assert private.read_text() == "retained" and client.get(record["resources"][0]["url"]).is_success


def test_oversized_chunked_request_rejected_while_spooling(monkeypatch):
    monkeypatch.setattr(mod_bundle, "MAX_BUNDLE", 100)
    start = b'--example\r\nContent-Disposition: form-data; name="file"; filename="x.momomod"\r\n\r\n'
    response = client.post("/api/mods", content=iter([start, b"x" * 70000, b"\r\n--example--\r\n"]),
                           headers={"Content-Type": "multipart/form-data; boundary=example"})
    assert response.status_code == 400 and "upload exceeds" in response.json()["detail"]


def test_process_interruption_before_or_after_index_commit(tmp_path):
    import subprocess
    import sys
    from pathlib import Path
    mods.install(package())
    mods.set_enabled("artist.evening", True)
    update = tmp_path / "candidate.momomod"
    update.write_bytes(package(version="2.0.0").getvalue())
    child = """
import os, sys
from pathlib import Path
from app.services import mods
from app.core import state
state.DATA_DIR = Path(sys.argv[1])
original_save = mods._save
def crash(record):
    if sys.argv[2] == 'after':
        original_save(record)
    os._exit(67)
mods._save = crash
with (state.DATA_DIR / 'candidate.momomod').open('rb') as f:
    mods.install(f)
"""
    for phase, version in (("before", "1.0.0"), ("after", "2.0.0")):
        result = subprocess.run([sys.executable, "-c", child, str(tmp_path), phase],
                                cwd=Path(__file__).resolve().parents[1])
        assert result.returncode == 67
        mods.restore(Host())
        active, = mods.listing()
        assert active["enabled"] and active["version"] == version
        assert client.get(active["resources"][0]["url"]).content == image()
        assert len(list((tmp_path / "mods/packages").iterdir())) == 1


def test_qq_uninstall_reclaims_resource_cache_and_preserves_credentials(integration, tmp_path):
    _, build = integration
    mods.install(build("momo.qq"))
    mods.set_enabled("momo.qq", True)
    private = tmp_path / "mod-data/momo.qq"
    cache = private / "resources/qualified-version"
    cache.mkdir(parents=True)
    (cache / "vendored-runtime").write_text("fixture")
    (private / "account").write_text("private")
    mods.uninstall("momo.qq")
    assert not (private / "resources").exists()
    assert (private / "account").read_text() == "private"


def test_explicit_zip_directory_entries_are_portable():
    bundle = package()
    with zipfile.ZipFile(bundle, "a") as archive:
        archive.mkdir("images/")
    assert mods.install(bundle)["id"] == "artist.evening"
