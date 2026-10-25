import io
import json
import zipfile
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.services import archive
from app.core import state, db


def test_desktop_http_capability_and_origin(monkeypatch):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 403
        assert (
            client.get("/api/health", headers={"x-momo-token": "a" * 64}).status_code
            == 200
        )
        assert (
            client.get(
                "/api/health", headers={"Authorization": "Bearer " + "a" * 64}
            ).status_code
            == 200
        )
        assert (
            client.get(
                "/api/health",
                headers={"x-momo-token": "a" * 64, "Origin": "https://evil.example"},
            ).status_code
            == 403
        )
        assert (
            client.get(
                "/api/state",
                headers={"x-momo-token": "a" * 64, "Origin": "tauri://localhost"},
            ).status_code
            == 200
        )


def test_websocket_requires_first_frame(monkeypatch):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    with TestClient(app) as client:
        with client.websocket_connect("/api/asr/stream") as ws:
            ws.send_json({"type": "authenticate", "token": "wrong"})
            assert ws.receive()["code"] == 1008


def test_archive_online_backup_restore_and_reject(tmp_path):
    state.write_state({"settings": {"llm": {"key": "local-secret"}}})
    db.conn().execute("INSERT INTO memories VALUES ('test','hello','now',0)")
    db.conn().commit()
    raw = archive.export_data()
    files = archive.validate(raw)
    assert b"local-secret" in files["momo.yaml"]
    db.conn().execute("DELETE FROM memories")
    db.conn().commit()
    archive.import_data(raw)
    assert db.conn().execute("SELECT content FROM memories").fetchone()[0] == "hello"
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as zipped:
        zipped.writestr("../bad", b"x")
        zipped.writestr("manifest.json", "{}")
    with pytest.raises(ValueError):
        archive.import_data(output.getvalue())
    assert db.conn().execute("SELECT content FROM memories").fetchone()[0] == "hello"


def test_archive_hash_failure_has_no_mutation():
    raw = archive.export_data()
    source = zipfile.ZipFile(io.BytesIO(raw))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as target:
        for entry in source.namelist():
            target.writestr(entry, b"bad" if entry == "momo.db" else source.read(entry))
    with pytest.raises(ValueError):
        archive.import_data(output.getvalue())
    assert db.conn().execute("SELECT id FROM sessions WHERE id='live'").fetchone()


def test_desktop_cubism_never_downloads(monkeypatch):
    from app.services import live2d

    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    monkeypatch.setenv("MOMO_RESOURCES_DIR", str(state.DATA_DIR / "missing"))
    monkeypatch.setattr(
        live2d.httpx,
        "get",
        lambda *a, **kw: pytest.fail("Desktop must not download runtime resources"),
    )
    with pytest.raises(ValueError, match="Bundled"):
        live2d.runtime()


@pytest.mark.parametrize(
    "endpoint",
    [
        "/api/state",
        "/api/memories",
        "/api/checkpoints",
        "/api/resources/status",
        "/api/data/export",
    ],
)
def test_private_endpoints_never_expose_data_without_capability(monkeypatch, endpoint):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    client = TestClient(app)
    assert client.get(endpoint).status_code == 403
    assert client.post("/api/chat/interrupt", json={}).status_code == 403


def test_websocket_auth_before_asr_model_allocation(monkeypatch):
    from app.services import asr

    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    allocated = []

    class Session:
        def __init__(self, lang):
            allocated.append(lang)

        def close(self):
            pass

    monkeypatch.setattr(asr, "AsrSession", Session)
    monkeypatch.setattr(asr, "status", lambda lang: {"language": lang})
    client = TestClient(app)
    with client.websocket_connect("/api/asr/stream") as ws:
        ws.send_json({"type": "finalize"})
        assert ws.receive()["code"] == 1008
    assert allocated == []
    with client.websocket_connect("/api/asr/stream") as ws:
        ws.send_json({"type": "authenticate", "token": "a" * 64})
        assert ws.receive_json()["type"] == "ready"
    assert len(allocated) == 1


def test_websocket_rejects_untrusted_origin_before_accept(monkeypatch):
    from starlette.websockets import WebSocketDisconnect

    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    with pytest.raises(WebSocketDisconnect):
        with TestClient(app).websocket_connect(
            "/api/asr/stream", headers={"origin": "https://evil.example"}
        ):
            pytest.fail("Untrusted origin accepted")


def rewrite_archive(raw, mutate):
    source = zipfile.ZipFile(io.BytesIO(raw))
    files = {name: source.read(name) for name in source.namelist()}
    mutate(files)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for name, content in files.items():
            target.writestr(name, content)
    return out.getvalue()


@pytest.mark.parametrize(
    "path",
    ["../outside", "/absolute", "tts/../../outside", "C:/outside", "tts\\outside"],
)
def test_archive_path_rejection_has_no_writes(path):
    raw = archive.export_data()
    raw = rewrite_archive(raw, lambda files: files.update({path: b"bad"}))
    with pytest.raises(ValueError):
        archive.import_data(raw)
    assert db.conn().execute("SELECT id FROM sessions WHERE id='live'").fetchone()


def test_archive_rejects_unsupported_version_and_missing_file():
    raw = archive.export_data()

    def version(files):
        manifest = json.loads(files["manifest.json"])
        manifest["version"] = 99
        files["manifest.json"] = json.dumps(manifest).encode()

    with pytest.raises(ValueError, match="version"):
        archive.validate(rewrite_archive(raw, version))
    with pytest.raises(ValueError, match="mismatch"):
        archive.validate(rewrite_archive(raw, lambda files: files.pop("momo.db")))


def test_archive_bounds_decompressed_size_and_duplicates(monkeypatch):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        target.writestr("momo.db", b"0" * 10000)
        target.writestr("manifest.json", "{}")
    monkeypatch.setattr(archive, "LIMIT", 1000)
    assert len(out.getvalue()) < 1000
    with pytest.raises(ValueError, match="limits"):
        archive.validate(out.getvalue())
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as target:
        target.writestr("momo.db", b"a")
        with pytest.warns(UserWarning):
            target.writestr("momo.db", b"b")
    with pytest.raises(ValueError, match="duplicates"):
        archive.validate(out.getvalue())


def test_archive_incomplete_sqlite_rejected_before_replacement(tmp_path):
    import sqlite3

    path = tmp_path / "incomplete.db"
    with sqlite3.connect(path) as con:
        con.execute("CREATE TABLE wrong(x)")
    raw = archive.export_data()

    def incomplete(files):
        data = path.read_bytes()
        files["momo.db"] = data
        manifest = json.loads(files["manifest.json"])
        manifest["files"]["momo.db"] = {
            "size": len(data),
            "sha256": archive.digest(data),
        }
        files["manifest.json"] = json.dumps(manifest).encode()

    with pytest.raises(ValueError, match="schema"):
        archive.import_data(rewrite_archive(raw, incomplete))
    assert db.conn().execute("SELECT id FROM sessions WHERE id='live'").fetchone()


def test_archive_replacement_failure_restores_previous_directory(monkeypatch):
    state.write_state({"sentinel": "previous"})
    raw = archive.export_data()
    replace = archive.os.replace

    def fail_stage(source, target):
        if str(source).endswith("/new"):
            raise OSError("Injected replacement failure")
        return replace(source, target)

    monkeypatch.setattr(archive.os, "replace", fail_stage)
    with pytest.raises(OSError, match="Injected"):
        archive.import_data(raw)
    assert state.read_state()["sentinel"] == "previous"
    assert db.conn().execute("SELECT id FROM sessions WHERE id='live'").fetchone()


def test_archive_cannot_move_original_keeps_original(monkeypatch):
    state.write_state({"sentinel": "original"})
    raw = archive.export_data()
    monkeypatch.setattr(
        archive.os,
        "replace",
        lambda *a: (_ for _ in ()).throw(OSError("Permission denied")),
    )
    with pytest.raises(OSError):
        archive.import_data(raw)
    assert state.read_state()["sentinel"] == "original"
    assert db.conn().execute("SELECT id FROM sessions WHERE id='live'").fetchone()


def test_archive_failed_rollback_preserves_recovery_copy(monkeypatch):
    state.write_state({"sentinel": "recoverable"})
    raw = archive.export_data()
    replace = archive.os.replace

    def fail_after_backup(source, target):
        if str(source).endswith("/new") or ".pre-import-" in str(source):
            raise OSError("Injected restore failure")
        return replace(source, target)

    monkeypatch.setattr(archive.os, "replace", fail_after_backup)
    with pytest.raises(OSError):
        archive.import_data(raw)
    copies = list(state.DATA_DIR.parent.glob(state.DATA_DIR.name + ".pre-import-*"))
    assert len(copies) == 1
    assert "recoverable" in (copies[0] / "momo.yaml").read_text()
    # Restore the isolated fixture explicitly without the injected failure.
    replace(copies[0], state.DATA_DIR)


def test_archive_restores_database_with_vector_virtual_tables():
    from app.models import vectors

    if db.sqlite_vec is None:
        pytest.skip("sqlite-vec unavailable")
    assert vectors.ensure(3, "archive-test")
    archive.import_data(archive.export_data())
    assert vectors.dim() == 3
    assert db.conn().execute("SELECT count(*) FROM memory_vec").fetchone()[0] == 0


def test_data_transfer_excludes_inflight_mutations():
    import asyncio
    import httpx
    from app.core.maintenance import DataMaintenance

    async def run():
        entered = asyncio.Event()
        release = asyncio.Event()

        async def endpoint(scope, receive, send):
            if scope["path"] == "/work":
                entered.set()
                await release.wait()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        app = DataMaintenance(endpoint)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            task = asyncio.create_task(client.post("/work"))
            await entered.wait()
            assert (await client.post("/api/data/import")).status_code == 409
            assert (await client.get("/api/data/export")).status_code == 409
            release.set()
            assert (await task).status_code == 200
            assert (await client.get("/api/data/export")).status_code == 200

    asyncio.run(run())


@pytest.mark.skipif(__import__("os").name == "nt", reason="Unix process groups")
def test_crash_guard_never_kills_inherited_process_group(monkeypatch):
    import desktop

    calls = []
    monkeypatch.setattr(desktop.os, "getpid", lambda: 1234)
    monkeypatch.setattr(desktop.os, "getpgrp", lambda: 500)
    monkeypatch.setattr(desktop.os, "killpg", lambda *args: calls.append(args))
    desktop.force_owned_group_exit()
    assert calls == []
    monkeypatch.setattr(desktop.os, "getpgrp", lambda: 1234)
    desktop.force_owned_group_exit()
    assert calls == [(1234, desktop.signal.SIGKILL)]


def test_trusted_native_view_can_read_auth_denial(monkeypatch):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    response = TestClient(app).get(
        "/api/health", headers={"origin": "tauri://localhost"}
    )
    assert response.status_code == 403
    assert response.headers.get("access-control-allow-origin") == "tauri://localhost"
    assert response.headers.get("vary") == "Origin"
    untrusted = TestClient(app).get(
        "/api/health", headers={"origin": "https://evil.example"}
    )
    assert "access-control-allow-origin" not in untrusted.headers


def test_fresh_profile_backup_has_explicit_default_configuration():
    files = archive.validate(archive.export_data())
    assert "momo.yaml" in files
    import yaml

    assert yaml.safe_load(files["momo.yaml"]) == state.DEFAULT_STATE
    assert not state.STATE_PATH.exists()  # Export never writes to the source profile.


def test_legacy_database_only_restore_materializes_default_configuration():
    raw = archive.export_data()

    def remove_configuration(files):
        files.pop("momo.yaml")
        manifest = json.loads(files["manifest.json"])
        manifest["files"].pop("momo.yaml")
        files["manifest.json"] = json.dumps(manifest).encode()

    raw = rewrite_archive(raw, remove_configuration)
    state.write_state({"settings": {"llm": {"key": "settings-after-export"}}})
    archive.import_data(raw)
    assert state.read_state() == state.DEFAULT_STATE


def test_archive_configuration_uses_utf8_on_non_utf8_windows_locale(monkeypatch):
    from pathlib import Path

    state.write_state({"settings": {"general": {"name": "中"}}})
    raw = archive.export_data()

    def unicode_configuration(files):
        import hashlib, yaml

        content = yaml.safe_dump(state.read_state(), allow_unicode=True).encode("utf-8")
        files["momo.yaml"] = content
        manifest = json.loads(files["manifest.json"])
        manifest["files"]["momo.yaml"] = {
            "size": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
        files["manifest.json"] = json.dumps(manifest).encode()

    raw = rewrite_archive(raw, unicode_configuration)
    read_text = Path.read_text

    def windows_locale_read(path, encoding=None, errors=None):
        return read_text(path, encoding=encoding or "cp936", errors=errors)

    monkeypatch.setattr(Path, "read_text", windows_locale_read)
    archive.import_data(raw)
    assert state.read_state()["settings"]["general"]["name"] == "中"


@pytest.mark.parametrize(
    "origin", ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
)
def test_native_view_can_read_audio_rate_and_interrupt_generation(monkeypatch, origin):
    import importlib.util
    from app import main
    from app.api import tts as tts_api, chat as chat_api

    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    # Configure the real entrypoint in desktop mode without mutating other tests' app.
    specification = importlib.util.spec_from_file_location(
        "app._native_cors_test", main.__file__
    )
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)

    async def synthesize(*args):
        async def chunks():
            yield b"\x01\x00" * 16

        return 32000, chunks()

    monkeypatch.setattr(tts_api.tts, "synthesize", synthesize)
    monkeypatch.setattr(chat_api.onboarding, "interrupt", lambda *args, **kwargs: 37)
    client = TestClient(module.app)
    headers = {"origin": origin, "x-momo-token": "a" * 64}
    speech = client.post(
        "/api/tts/speech",
        headers=headers,
        json={"input": "Synthetic audio", "lang": "en"},
    )
    assert speech.status_code == 200 and speech.headers["x-sample-rate"] == "32000"
    interrupt = client.post(
        "/api/chat/interrupt",
        headers=headers,
        json={"user": "Synthetic", "assistant": ""},
    )
    assert (
        interrupt.status_code == 204 and interrupt.headers["x-momo-generation"] == "37"
    )
    for response in [speech, interrupt]:
        assert response.headers["access-control-allow-origin"] == origin
        exposed = {
            name.strip().lower()
            for name in response.headers.get("access-control-expose-headers", "").split(
                ","
            )
        }
        assert exposed == {"x-sample-rate", "x-momo-generation"}
    denied = client.post(
        "/api/tts/speech",
        headers={**headers, "origin": "https://untrusted.example"},
        json={"input": "Synthetic"},
    )
    assert denied.status_code == 403
    assert "access-control-allow-origin" not in denied.headers
