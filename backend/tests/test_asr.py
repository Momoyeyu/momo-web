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
