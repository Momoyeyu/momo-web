"""Local conversation holds phone work, not the owner's approved observation."""
import base64
import io
import threading
import time
from types import SimpleNamespace

import pytest
from PIL import Image
from app.services import computer_tools, native_control, computer, app_permissions, activities, checkpoint
from app.services.coordinator import Coordinator, current_run, CoordinationError


@pytest.fixture
def local(tmp_path, monkeypatch):
    runtime = Coordinator()
    runtime.started = True
    runtime.mode = 'meeting'
    runtime.owner = {'clientId': 'owner', 'leaseId': 'lease', 'expiresAt': time.monotonic()+60}
    pixels = io.BytesIO()
    Image.new('RGB', (32, 32), 'white').save(pixels, 'PNG')
    target = {'windowId': 1, 'ownerPid': 12, 'path': '/Applications/Test.app', 'bundleId': 'test.app', 'name': 'Test'}
    calls = []
    def request(method, params=None):
        calls.append(method)
        if method == 'native.targets': return {'targets': [target]}
        if method == 'native.observe': return {'data': base64.b64encode(pixels.getvalue()).decode(), 'version': 1}
        return {'ok': True, 'bindingId': 'fixture'}
    runtime.host = SimpleNamespace(control=threading.RLock(), request=request, permit=lambda _: {})
    for module in (computer_tools, native_control, computer): monkeypatch.setattr(module, 'runtime', runtime)
    monkeypatch.setattr(activities, 'require_enabled', lambda _: None)
    monkeypatch.setattr(activities, 'snapshot', lambda: {'enabled': {'computer': True}})
    # Vision provider configuration is external to the attention lifecycle under test.
    monkeypatch.setattr(computer.vision, 'require_enabled', lambda _: None)
    permissions = app_permissions.AppPermissions(tmp_path/'permissions.json')
    monkeypatch.setattr(app_permissions, 'permissions', permissions)
    screen = computer.Computer()
    native = native_control.NativeControl()
    monkeypatch.setattr(computer, 'computer', screen)
    monkeypatch.setattr(native_control, 'native_control', native)
    approval = native.start(1, 12, ['observe', 'interact'], 'owner', 'lease')
    permissions.decide(approval['requestId'], 'once', runtime.epoch)
    native.start(1, 12, ['observe', 'interact'], 'owner', 'lease')
    yield runtime, native, screen, permissions, calls
    screen.stop()


def test_prepared_owner_run_keeps_approved_tools_and_can_observe_and_act(local):
    runtime, native, screen, _, calls = local
    runtime.prepare_local('owner', 'lease')
    assert runtime.interrupt_hold
    with runtime.run('owner-run', client='owner', lease='lease'):
        token = current_run.set('owner-run')
        try:
            names = {row['function']['name'] for row in computer_tools.declarations()}
            assert {'computer_observe', 'computer_action'} <= names
            assert native.execute({'action': 'observe'})['version'] == 1
            assert native.execute({'action': 'type', 'text': 'fixture'}, 1)['ok']
            screen.gate()
        finally: current_run.reset(token)
    assert 'native.action' in calls
    assert not runtime.interrupt_hold


def test_background_capture_survives_prepare_and_owner_response(local):
    runtime, native, screen, _, _ = local
    runtime.prepare_local('owner', 'lease')
    generation = screen.generation
    with runtime.run('owner-run', client='owner', lease='lease'):
        native.frame('owner', 'lease')
        assert screen.snapshot()['observing']
        assert screen.generation == generation
        assert screen.claim_reaction(generation, 'owner', 'lease') is None
    assert screen.snapshot()['observing']


@pytest.mark.parametrize('denial', ['old-run', 'remote', 'audience', 'focus', 'restoring', 'revoked', 'epoch'])
def test_owner_hold_does_not_bypass_other_gates(local, denial):
    runtime, native, screen, permissions, calls = local
    runtime.prepare_local('owner', 'lease')
    with runtime.run('owner-run', client='owner', lease='lease'):
        token = current_run.set('old-run' if denial == 'old-run' else 'owner-run')
        try:
            if denial == 'remote': runtime.activity['source'] = 'qq'
            if denial == 'focus': runtime.focus = True
            if denial == 'restoring': runtime.restoring = True
            if denial == 'revoked': permissions.revoke_grant(native.grant)
            if denial == 'epoch': runtime.epoch += 1
            with checkpoint.audience_scope('external' if denial == 'audience' else 'owner'):
                before = len(calls)
                with pytest.raises(ValueError): native.execute({'action': 'type', 'text': 'denied'}, 1)
                assert len(calls) == before
        finally: current_run.reset(token)


def test_hold_still_denies_remote_admission_and_unowned_background_capture(local):
    runtime, native, _, _, _ = local
    runtime.prepare_local('owner', 'lease')
    with pytest.raises(CoordinationError):
        with runtime.run('remote', source='qq'): pass
    with pytest.raises(CoordinationError): native.frame('other', 'lease')


def test_pre_admission_hold_keeps_capture_but_suppresses_proactive_reaction(local):
    runtime, native, screen, _, _ = local
    screen.proactive = screen.reactions = True
    runtime.prepare_local('owner', 'lease')
    native.frame('owner', 'lease')
    assert not runtime.active
    assert screen.snapshot()['observing']
    assert screen.claim_reaction(screen.generation, 'owner', 'lease') is None
    # Completing the admitted local response releases the phone hold.
    with runtime.run('owner-run', client='owner', lease='lease'): pass
    assert screen.claim_reaction(screen.generation, 'owner', 'lease') == {'generation': screen.generation}
