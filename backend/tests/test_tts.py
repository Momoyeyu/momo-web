"""TTS 代理：状态与合成端点（上游用 stub，不依赖真实 GPT-SoVITS）。

真上游联调在 e2e / 手工验证里做；这里守住协议形状与错误映射。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import tts


class _FakeStream:
    def __init__(self, sr: int = 32000, body: bytes = b"\x01\x02" * 100) -> None:
        self.sr = sr
        self.body = body

    async def synthesize(self, text: str, lang: str | None = None):
        async def gen():
            yield self.body

        return self.sr, gen()


def test_status_shape():
    body = TestClient(app).get("/api/tts/status").json()
    assert body["engine"] == "gpt-sovits"
    assert {"configured", "reachable", "detail"} <= set(body)


def test_speech_streams_pcm_with_sample_rate(monkeypatch):
    fake = _FakeStream(sr=48000)

    async def synthesize(text, lang=None):
        return await fake.synthesize(text, lang)

    monkeypatch.setattr(tts, "synthesize", synthesize)
    c = TestClient(app)
    r = c.post("/api/tts/speech", json={"input": "你好", "lang": "zh"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/pcm")
    assert r.headers["x-sample-rate"] == "48000"
    assert r.content == fake.body


def test_speech_reports_unconfigured(monkeypatch):
    async def boom(text, lang=None):
        raise tts.TtsError("未上传参考音频")

    monkeypatch.setattr(tts, "synthesize", boom)
    r = TestClient(app).post("/api/tts/speech", json={"input": "你好"})
    assert r.status_code == 503
    assert "参考音频" in r.json()["detail"]


def test_speech_rejects_empty_input():
    r = TestClient(app).post("/api/tts/speech", json={"input": "  "})
    assert r.status_code == 400


def test_upload_ref_overwrites(tmp_path, monkeypatch):
    """上传参考音频：写进 data/tts，重复上传覆盖同前缀文件。"""
    monkeypatch.setattr(tts, "REF_DIR", tmp_path)
    c = TestClient(app)
    r1 = c.post(
        "/api/tts/ref",
        files={"file": ("a.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )
    assert r1.status_code == 200 and r1.json()["name"] == "a.wav"
    assert (tmp_path / "a.wav").read_bytes().startswith(b"RIFF")

    r2 = c.post(
        "/api/tts/ref",
        files={"file": ("b.mp3", b"ID3fake-mp3", "audio/mpeg")},
    )
    assert r2.status_code == 200 and r2.json()["name"] == "b.mp3"
    assert not (tmp_path / "a.wav").exists()  # 旧文件被清掉（单槽语义）
    assert (tmp_path / "b.mp3").exists()


def test_upload_ref_rejects_bad_type(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, "REF_DIR", tmp_path)
    r = TestClient(app).post(
        "/api/tts/ref", files={"file": ("x.txt", b"hello", "text/plain")}
    )
    assert r.status_code == 400


def test_payload_uses_base64_ref_audio(tmp_path, monkeypatch):
    """合成请求带 ref_audio(base64)，不再依赖服务端路径。"""
    import base64 as b64

    monkeypatch.setattr(tts, "REF_DIR", tmp_path)
    (tmp_path / "ref.wav").write_bytes(b"RIFFxxxx")
    monkeypatch.setattr(
        tts,
        "_cfg",
        lambda: {
            "url": "http://tts.invalid",
            "key": "",
            "voice": "ref.wav",
            "prompt": "参考文本",
        },
    )
    captured = {}

    class _Client:
        def __init__(self, *a, **kw): ...
        def build_request(self, method, url, json=None):
            captured["url"] = url
            captured["json"] = json
            raise tts.httpx.HTTPError("stop here")

        async def aclose(self): ...

    monkeypatch.setattr(tts.httpx, "AsyncClient", _Client)
    import asyncio
    import pytest

    with pytest.raises(tts.TtsError):
        asyncio.run(tts.synthesize("你好", "zh"))
    assert captured["url"] == "http://tts.invalid/tts"
    payload = captured["json"]
    assert "ref_audio_path" not in payload
    assert b64.b64decode(payload["ref_audio"]) == b"RIFFxxxx"
    assert payload["prompt_text"] == "参考文本"
