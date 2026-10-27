import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.core.desktop_auth import allowed_origins


@pytest.mark.parametrize("origin", ["http://127.0.0.1:5177", "http://localhost:5177"])
def test_selected_web_port_accepts_both_local_names_with_capability(monkeypatch, origin):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    monkeypatch.setenv("MOMO_WEB_ORIGIN", "http://127.0.0.1:5177")
    client = TestClient(app)
    assert client.get("/api/health", headers={"origin": origin, "x-momo-token": "a" * 64}).status_code == 200
    assert client.get("/api/health", headers={"origin": origin}).status_code == 403


@pytest.mark.parametrize("origin", [
    "http://localhost:5178", "http://127.0.0.1:5178", "http://localhost.evil:5177",
    "http://127.0.0.1.evil:5177", "http://localhost:5177/", "null", "https://localhost:5177",
])
def test_alias_support_does_not_admit_other_origins(monkeypatch, origin):
    monkeypatch.setenv("MOMO_DESKTOP_TOKEN", "a" * 64)
    monkeypatch.setenv("MOMO_WEB_ORIGIN", "http://127.0.0.1:5177")
    assert TestClient(app).get("/api/health", headers={"origin": origin, "x-momo-token": "a" * 64}).status_code == 403


@pytest.mark.parametrize("configured", [
    "http://127.0.0.1:5177/", "http://127.0.0.1:5177?x=1", "http://user@127.0.0.1:5177",
    "https://127.0.0.1:5177", "http://127.0.0.1.evil:5177", "http://127.0.0.1:0",
])
def test_malformed_startup_origin_does_not_create_web_grants(monkeypatch, configured):
    monkeypatch.setenv("MOMO_WEB_ORIGIN", configured)
    assert not any(origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:") for origin in allowed_origins())
