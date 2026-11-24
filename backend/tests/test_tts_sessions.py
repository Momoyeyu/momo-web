from __future__ import annotations

import asyncio
import time
import uuid

import httpx

from app.services.coordinator import Coordinator
from app.services import tts_sessions


async def _until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.005)


def test_meeting_identity_is_unavailable_outside_valid_activation():
    runtime = Coordinator()
    runtime.started = True
    runtime.owner = {"clientId": "window", "leaseId": "local-lease", "expiresAt": time.monotonic() + 60}
    assert runtime.active_meeting_id() is None
    runtime.mode = "meeting"
    assert runtime.active_meeting_id() == "local-lease"
    runtime.owner["expiresAt"] = time.monotonic() - 1
    assert runtime.active_meeting_id() is None


def test_renews_and_releases_on_provider_change_leave_and_shutdown(monkeypatch):
    async def exercise():
        selected = None
        calls = []

        async def gateway(request):
            calls.append((request.method, request.url.host, request.url.path, request.headers.get("authorization")))
            return httpx.Response(204)

        index = tts_sessions.Target("local-meeting", "index-tts", "http://index.test", "Bearer index")
        gpt = tts_sessions.Target("local-meeting", "gpt-sovits", "http://gpt.test", "Bearer gpt")
        lifecycle = tts_sessions.VoiceSessions(lambda: selected)
        monkeypatch.setattr(tts_sessions, "_CHECK_SECONDS", .01)
        monkeypatch.setattr(tts_sessions, "_RENEW_SECONDS", .02)
        async with lifecycle.running(transport=httpx.MockTransport(gateway)):
            await asyncio.sleep(.02)
            assert not calls
            selected = index
            lifecycle.wake()
            await _until(lambda: len(calls) >= 2)
            first = calls[0]
            assert first[:2] == ("PUT", "index.test")
            assert uuid.UUID(first[2].removeprefix("/session/")).version == 4
            assert first[3] == "Bearer index"
            assert calls[1] == first

            selected = gpt
            lifecycle.wake()
            await _until(lambda: any(call[:2] == ("PUT", "gpt.test") for call in calls))
            assert ("DELETE", *first[1:]) in calls
            second = next(call for call in calls if call[:2] == ("PUT", "gpt.test"))
            assert second[2] != first[2]
            assert second[3] == "Bearer gpt"

            selected = None
            lifecycle.wake()
            await _until(lambda: ("DELETE", *second[1:]) in calls)
            selected = index
            lifecycle.wake()
            await _until(lambda: len({call[2] for call in calls if call[0] == "PUT"}) == 3)
            last = calls[-1]
        assert calls[-1] == ("DELETE", *last[1:])

    asyncio.run(exercise())


def test_legacy_404_uses_one_capability_check_and_no_release(monkeypatch):
    async def exercise():
        calls = []

        def unsupported(request):
            calls.append(request.method)
            return httpx.Response(404)

        configured = tts_sessions.Target("meeting", "gpt-sovits", "http://existing.test", None)
        lifecycle = tts_sessions.VoiceSessions(lambda: configured)
        monkeypatch.setattr(tts_sessions, "_CHECK_SECONDS", .01)
        monkeypatch.setattr(tts_sessions, "_RENEW_SECONDS", .01)
        async with lifecycle.running(transport=httpx.MockTransport(unsupported)):
            await _until(lambda: calls)
            await asyncio.sleep(.035)
        assert calls == ["PUT"]

    asyncio.run(exercise())


def test_effective_endpoint_requires_live_meeting_and_reference(monkeypatch, tmp_path):
    monkeypatch.delenv("MOMO_DESKTOP_TOKEN", raising=False)
    local_id = None
    config = {
        "engine": "index-tts",
        "url": "http://legacy.test",
        "key": "gpt-private",
        "indexUrl": "http://index.test/prefix/",
        "indexKey": "index-private",
        "voice": "ref.wav",
    }
    monkeypatch.setattr(tts_sessions.runtime, "active_meeting_id", lambda: local_id)
    monkeypatch.setattr(tts_sessions.tts, "_cfg", lambda: config)
    monkeypatch.setattr(tts_sessions.tts, "REF_DIR", tmp_path)
    assert tts_sessions._target() is None

    local_id = "meeting"
    assert tts_sessions._target() is None
    (tmp_path / "ref.wav").touch()
    target = tts_sessions._target()
    assert target == tts_sessions.Target("meeting", "index-tts", "http://index.test/prefix", "Bearer index-private")
    assert "index-private" not in repr(target)

    config["indexUrl"] = "http://index.test/private?key=secret"
    assert tts_sessions._target() is None
    config["indexUrl"] = 7
    assert tts_sessions._target() is None


def test_native_tts_lifetime_starts_before_boot_and_survives_return_to_title(monkeypatch, tmp_path):
    config = {"engine": "index-tts", "indexUrl": "http://index.test", "voice": "ref.wav"}
    (tmp_path / "ref.wav").touch()
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "native-capability")
    monkeypatch.delenv("MOMO_WEB_ORIGIN", raising=False)
    monkeypatch.setattr(tts_sessions.tts, "_cfg", lambda: config)
    monkeypatch.setattr(tts_sessions.tts, "REF_DIR", tmp_path)
    meeting = None
    monkeypatch.setattr(tts_sessions.runtime, "active_meeting_id", lambda: meeting)

    startup = tts_sessions._target()
    assert startup is not None and startup.engine == "index-tts"
    meeting = "booted"
    assert tts_sessions._target() == startup
    meeting = None
    assert tts_sessions._target() == startup

    monkeypatch.setenv("MOMO_WEB_ORIGIN", "http://127.0.0.1:5173")
    assert tts_sessions._target() is None
