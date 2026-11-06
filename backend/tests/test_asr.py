"""内置 ASR：状态与 WS 协议。

真模型（~240MB）不进 CI：用 stub session 验证协议形状；
模型存在时额外跑一条端到端（否则 skip）。
"""
from __future__ import annotations

import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import asr


class _StubSession:
    """协议用的替身：固定吐事件，验证 API 层的转发与收尾。"""

    def __init__(self, lang: str) -> None:
        self.lang = lang

    def feed(self, pcm: bytes):
        # 第一帧触发开始说话 + 一段文本；之后静默
        if not getattr(self, "_sent", False):
            self._sent = True
            return [
                {"type": "speech_started"},
                {"type": "transcript", "text": "测试文本"},
            ]
        return []

    def flush(self):
        return [{"type": "transcript", "text": "收尾文本"}]

    def close(self):
        self.closed = True


def test_status_shape():
    c = TestClient(app)
    body = c.get("/api/asr/status").json()
    assert body["engine"] == "sensevoice"
    assert isinstance(body["ready"], bool)
    assert isinstance(body["missing"], list)
    assert body["language"] in {"zh", "en", "ja", "auto"}


def test_stream_protocol(monkeypatch):
    monkeypatch.setattr(asr, "AsrSession", _StubSession)
    c = TestClient(app)
    with c.websocket_connect("/api/asr/stream") as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(b"\x00\x01" * 1600)
        ev1 = ws.receive_json()
        ev2 = ws.receive_json()
        assert [ev1["type"], ev2["type"]] == ["speech_started", "transcript"]
        assert ev2["text"] == "测试文本"
        ws.send_text('{"type":"finalize"}')
        assert ws.receive_json()["text"] == "收尾文本"
        assert ws.receive_json()["type"] == "finalized"


def test_stream_reports_missing_models(monkeypatch):
    def boom(lang: str):
        raise asr.AsrError("模型缺失：sense-voice/model.int8.onnx")

    monkeypatch.setattr(asr, "AsrSession", boom)
    c = TestClient(app)
    with c.websocket_connect("/api/asr/stream") as ws:
        ev = ws.receive_json()
        assert ev["type"] == "error" and "模型缺失" in ev["message"]


@pytest.mark.skipif(not asr.ready(), reason="内置 ASR 模型未下载")
def test_end_to_end_wav(tmp_path: Path):
    """真模型：合成一段静音+语音，校验拿到最终文本。

    用纯静音会得到空文本（VAD 不触发），所以这里只断言协议闭环：
    ready →（可能有 speech_started）→ finalized。
    """
    wav = tmp_path / "silence.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 16000)

    c = TestClient(app)
    with c.websocket_connect("/api/asr/stream") as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_bytes(wav.read_bytes()[44:])
        ws.send_text('{"type":"finalize"}')
        while True:
            ev = ws.receive_json()
            if ev["type"] == "finalized":
                break
            assert ev["type"] in {"speech_started", "transcript"}


@pytest.fixture
def stub_models(monkeypatch):
    """Exercise native resource ownership without loading the 228 MiB model."""
    import types
    import sys
    calls = []

    class Recognizer:
        @staticmethod
        def from_sense_voice(**kwargs):
            calls.append(kwargs["language"])
            return object()

    monkeypatch.setitem(sys.modules, "sherpa_onnx", types.SimpleNamespace(OfflineRecognizer=Recognizer))
    monkeypatch.setattr(asr, "_ensure_onnxruntime_lib", lambda: None)
    monkeypatch.setattr(asr, "_verify_models", lambda: None)
    monkeypatch.setattr(asr, "ready", lambda: True)
    monkeypatch.setattr(asr, "_vad", lambda: object())
    monkeypatch.setattr(asr, "_recognizers", {})
    monkeypatch.setattr(asr, "_active_sessions", 0)
    return calls


def test_recognizer_has_one_resident_language_and_releases_final_session(stub_models):
    first = asr.AsrSession("zh")
    second = asr.AsrSession("en")
    assert stub_models == ["zh", "en"]
    assert set(asr._recognizers) == {"en"}
    first.close()
    assert asr._active_sessions == 1
    assert len(asr._recognizers) == 1
    second.close()
    second.close()
    assert asr._active_sessions == 0
    assert not asr._recognizers
    assert second._vad is None
    with pytest.raises(asr.AsrError, match="关闭"):
        second.feed(b"\0\0")


def test_concurrent_sessions_allocate_one_recognizer(stub_models):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        sessions = list(pool.map(asr.AsrSession, ["zh"] * 8))
    assert stub_models == ["zh"]
    assert asr._active_sessions == 8
    for session in sessions:
        session.close()
    assert not asr._recognizers


def test_integrity_rejects_corruption_and_caches_unchanged_files(tmp_path, monkeypatch):
    import hashlib
    import json
    model = tmp_path / "asr/sense-voice/model.int8.onnx"
    model.parent.mkdir(parents=True)
    model.write_bytes(b"valid model")
    manifest = {"files": [{"path": "sense-voice/model.int8.onnx", "size_bytes": 11,
                            "sha256": hashlib.sha256(b"valid model").hexdigest()}]}
    for relative in ("sense-voice/tokens.txt", "silero_vad.onnx"):
        resource = tmp_path / "asr" / relative
        resource.write_bytes(b"small")
        manifest["files"].append({"path": relative, "size_bytes": 5,
                                  "sha256": hashlib.sha256(b"small").hexdigest()})
    (model.parents[1] / "manifest.json").write_text(json.dumps(manifest))
    monkeypatch.setenv("MOMO_RESOURCES_DIR", str(tmp_path))
    monkeypatch.setattr(asr, "MODELS_DIR", tmp_path / "asr")
    monkeypatch.setattr(asr, "_integrity_stamp", None)
    asr._verify_models()
    stamp = asr._integrity_stamp
    asr._verify_models()
    assert asr._integrity_stamp is stamp
    model.write_bytes(b"bad content")
    with pytest.raises(asr.AsrError, match="损坏"):
        asr._verify_models()


def test_status_rejects_truncated_model_without_loading_or_hashing(tmp_path, monkeypatch):
    target = tmp_path / "model.int8.onnx"
    target.write_bytes(b"truncated")
    monkeypatch.setattr(asr, "MODEL_PATH", target)
    monkeypatch.setattr(asr, "_ensure_onnxruntime_lib", lambda: pytest.fail("status must not load native runtimes"))
    assert not asr.ready()
    assert "sense-voice/model.int8.onnx" in asr.missing_models()
