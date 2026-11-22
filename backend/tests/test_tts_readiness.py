"""Official deployment readiness is stricter than an HTTP documentation page."""
import asyncio
import httpx
import pytest
from app.services import tts

@pytest.mark.parametrize('ready_status,payload,docs_status,expected,paths', [
    (200, {'ready': True, 'status': 'ready'}, 200, True, ['/readyz']),
    (200, {'ready': False, 'status': 'loading'}, 200, False, ['/readyz']),
    (503, {'ready': False, 'status': 'failed'}, 200, False, ['/readyz']),
    (401, {}, 200, False, ['/readyz']),
    (404, {}, 200, True, ['/readyz', '/docs']),
    (404, {}, 404, False, ['/readyz', '/docs']),
    (405, {}, 200, True, ['/readyz', '/docs']),
])
def test_status_uses_readiness_and_only_falls_back_for_missing_endpoint(monkeypatch, tmp_path, ready_status, payload, docs_status, expected, paths):
    ref = tmp_path / 'ref.wav'; ref.write_bytes(b'RIFFfixture')
    monkeypatch.setattr(tts, '_cfg', lambda: {'url': 'http://tts.test', 'voice': 'ref.wav', 'key': 'fixture-key'})
    monkeypatch.setattr(tts, 'ref_path', lambda cfg: ref)
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path == '/readyz': return httpx.Response(ready_status, json=payload)
        return httpx.Response(docs_status, text='documentation')
    original = httpx.AsyncClient
    monkeypatch.setattr(tts.httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    result = asyncio.run(tts.status())
    assert result['reachable'] is expected
    assert [request.url.path for request in requests] == paths
    assert all(request.headers['authorization'] == 'Bearer fixture-key' for request in requests)


def test_index_requires_readyz_without_probing_gpt_docs(monkeypatch, tmp_path):
    ref = tmp_path / "ref.wav"
    ref.write_bytes(b"RIFFfixture")
    monkeypatch.setattr(tts, "_cfg", lambda: {
        "engine": "index-tts", "indexUrl": "http://index.test", "indexKey": "index-key",
        "url": "http://legacy.test", "voice": ref.name,
    })
    monkeypatch.setattr(tts, "ref_path", lambda cfg: ref)
    calls = []

    def handler(request):
        calls.append((str(request.url), request.headers["Authorization"]))
        return httpx.Response(404)

    original = httpx.AsyncClient
    monkeypatch.setattr(tts.httpx, "AsyncClient", lambda **kwargs: original(
        transport=httpx.MockTransport(handler), **kwargs,
    ))
    status = asyncio.run(tts.status())
    assert status["engine"] == "index-tts" and not status["reachable"]
    assert calls == [("http://index.test/readyz", "Bearer index-key")]
