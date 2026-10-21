from fastapi.testclient import TestClient
from app.main import app
from app.core import state


def test_cubism_runtime_is_cached_and_served_without_network_on_second_request(monkeypatch):
    from app.services import live2d
    calls = []
    def download(*args, **kwargs):
        import httpx
        calls.append(1)
        return httpx.Response(200, content=b'var Live2DCubismCore = {};' + b' ' * 11000)
    monkeypatch.setattr(live2d.httpx, 'get', download)
    client = TestClient(app)
    first = client.get('/api/live2d/core')
    assert first.status_code == 200
    assert 'javascript' in first.headers['content-type']
    assert client.get('/api/live2d/core').content == first.content
    assert calls == [1]
    assert (state.DATA_DIR / 'cache/cubism-core-05.js').is_file()


def test_cubism_download_error_does_not_cache_error_page(monkeypatch):
    from app.services import live2d
    import httpx
    monkeypatch.setattr(live2d.httpx, 'get', lambda *a, **kw: httpx.Response(200, content=b'login required'))
    assert TestClient(app).get('/api/live2d/core').status_code == 502
    assert not (state.DATA_DIR / 'cache/cubism-core-05.js').exists()
