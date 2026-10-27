from fastapi.testclient import TestClient

from app.main import app
import pytest


@pytest.mark.parametrize("field,value", [("endpoint", "ws://127.0.0.1:3001"), ("token", "unused-old-secret")])
def test_native_qq_api_rejects_removed_bridge_fields(field, value):
    response = TestClient(app).put('/api/social/accounts/qq', json={field: value})
    assert response.status_code == 422


def test_native_qq_api_rejects_external_transport():
    response = TestClient(app).post('/api/social/accounts/qq/connect', json={"transport": "external"})
    assert response.status_code == 422


def test_account_api_is_separate_from_general_configuration_and_exposes_native_only_settings():
    client = TestClient(app)
    assert [row['provider'] for row in client.get('/api/social/accounts').json()['accounts']] == ['qq']
    body = {'enabled': False, 'accountId': 'qq-main', 'expectedSelfId': '12345'}
    response = client.put('/api/social/accounts/qq', json=body)
    assert response.status_code == 200
    assert response.json()['transport'] == 'managed'
    assert not {'endpoint', 'token', 'hasCredential'}.intersection(response.json())
    assert 'qq-main' not in client.get('/api/state').text
    assert client.put('/api/social/accounts/qq', json={'ownerPeerId': '999'}).status_code == 422
    assert client.put('/api/social/accounts/qq', json={'permissions': {'proactive': True}}).status_code == 400


def test_account_api_cannot_reconcile_another_accounts_command():
    response = TestClient(app).post('/api/social/accounts/qq/reconcile', json={
        'commandId': 'not-owned', 'outcome': 'closed_unknown'})
    assert response.status_code == 400


def test_account_api_uses_normal_local_capability_authentication(monkeypatch):
    monkeypatch.setenv('MOMO_DESKTOP_TOKEN', 'local-private-capability')
    client = TestClient(app)
    response = client.get('/api/social/accounts')
    assert response.status_code == 403
    assert client.get('/api/social/accounts', headers={'x-momo-token': 'local-private-capability'}).status_code == 200


def test_retired_provider_routes_reject_before_account_access():
    client = TestClient(app)
    for method, path, body in [
        ("put", "/wechat", {"enabled": True}),
        ("post", "/wechat/connect", None),
        ("post", "/wechat/disconnect", None),
        ("post", "/wechat/resume", None),
        ("post", "/wechat/owner-challenge", {"peerId": "old-peer"}),
        ("get", "/wechat/records", None),
        ("post", "/wechat/reconcile", {"commandId": "old-command", "outcome": "closed_unknown"}),
    ]:
        response = getattr(client, method)("/api/social/accounts" + path, **({"json": body} if body is not None else {}))
        assert response.status_code == 422
