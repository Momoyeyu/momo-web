"""A reachable provider must still accept the exact model before setup succeeds."""
import httpx
from fastapi.testclient import TestClient

from app.api import probe
from app.main import app


def provider(monkeypatch, handler):
    client = httpx.AsyncClient
    monkeypatch.setattr(probe.httpx, 'AsyncClient', lambda **kwargs: client(
        **kwargs, transport=httpx.MockTransport(handler)))


def test_probe_rejects_a_model_with_wrong_case_without_exposing_provider_body(monkeypatch):
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': 'deepseek-chat'}]})
        return httpx.Response(400, json={'error': {'message': 'Invalid model; secret-provider-body'}})
    provider(monkeypatch, respond)
    response = TestClient(app).post('/api/probe/llm', json={
        'url': 'https://provider.test', 'key': 'private-key', 'model': 'Deepseek-chat'})
    assert response.status_code == 200
    assert response.json() == {'ok': False, 'detail': 'HTTP 400'}
    assert 'private-key' not in response.text and 'secret-provider-body' not in response.text


def test_probe_checks_the_requested_model_even_if_it_is_a_working_unlisted_alias(monkeypatch):
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(404)
        import json
        body = json.loads(request.content)
        if request.url.path == '/v1/chat/completions' and body.get('model') == 'custom-CaseSensitive' and request.headers.get('authorization') == 'Bearer private-key':
            return httpx.Response(200, json={'choices': [{'message': {'content': 'OK'}}]})
        return httpx.Response(400)
    provider(monkeypatch, respond)
    response = TestClient(app).post('/api/probe/llm', json={
        'url': 'https://provider.test', 'key': 'private-key', 'model': 'custom-CaseSensitive'})
    assert response.json()['ok'] is True


def test_model_probe_does_not_accept_a_models_only_endpoint(monkeypatch):
    provider(monkeypatch, lambda request: httpx.Response(200, json={'data': []}) if request.method == 'GET' else httpx.Response(401))
    response = TestClient(app).post('/api/probe/llm', json={
        'url': 'https://provider.test', 'model': 'chat'})
    assert response.json() == {'ok': False, 'detail': 'HTTP 401'}


def test_probe_does_not_require_extra_generation_parameters_that_real_chat_omits(monkeypatch):
    def respond(request):
        import json
        body = json.loads(request.content) if request.content else {}
        if request.method != 'POST' or 'max_tokens' in body:
            return httpx.Response(400)
        return httpx.Response(200, json={'choices':[{'message':{'content':'OK'}}]})
    provider(monkeypatch, respond)
    response = TestClient(app).post('/api/probe/llm', json={
        'url':'https://provider.test','model':'chat'})
    assert response.json()['ok'] is True
