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
        if method in ('native.observe','native.screen'): return {'data': base64.b64encode(pixels.getvalue()).decode(), 'version': 1}
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
    screen.desktop_frame()
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


def test_background_scheduler_does_not_invalidate_model_observation(local):
    runtime, native, _, _, calls = local
    runtime.prepare_local('owner', 'lease')
    with runtime.run('owner-run', client='owner', lease='lease'):
        token = current_run.set('owner-run')
        try:
            native.execute({'action': 'observe'})
            before = len(calls)
            assert native.frame('owner', 'lease')['observationAvailable']
            assert calls[before:] == ['computer.start','native.screen']
            native.execute({'action': 'type', 'text': 'fixture'}, 1)
        finally: current_run.reset(token)


def test_screen_capture_does_not_replace_model_input_observation(local):
    runtime,native,screen,_,calls=local
    runtime.prepare_local('owner','lease')
    with runtime.run('owner-run',client='owner',lease='lease'):
        token=current_run.set('owner-run')
        try:
            native.execute({'action':'observe'})
            screen.desktop_frame()
            native.execute({'action':'type','text':'fixture'},1)
            assert 'native.screen' in calls and 'native.action' in calls
        finally:current_run.reset(token)


def test_minecraft_current_owner_run_can_use_existing_game_during_local_hold(local,monkeypatch):
    from app.services import minecraft as module
    runtime,native,_,_,calls=local
    native.stop()
    monkeypatch.setattr(module,'runtime',runtime)
    game=module.Minecraft()
    game.connect(17643,'fixture-token','fixture-world','fixture-account',['game.observe','game.chat'],'owner','lease')
    runtime.prepare_local('owner','lease')
    with runtime.run('owner-run',client='owner',lease='lease'):
        token=current_run.set('owner-run')
        try:
            assert game.execute('observe',{},game.generation,None,None)['ok']
            runtime.focus=True
            before=len(calls)
            with pytest.raises(ValueError):game.execute('chat',{'text':'denied'},game.generation,None,None)
            assert len(calls)==before
        finally:current_run.reset(token)


def test_minecraft_late_observation_after_focus_is_discarded(local,monkeypatch):
    from app.services import minecraft as module
    runtime,native,_,_,_=local
    native.stop();monkeypatch.setattr(module,'runtime',runtime)
    game=module.Minecraft()
    game.connect(17643,'fixture-token','fixture-world','fixture-account',['game.observe'],'owner','lease')
    original=runtime.host.request
    def request(method,params=None):
        result=original(method,params)
        if method=='minecraft.observe':runtime.focus=True
        return result
    runtime.host.request=request
    runtime.prepare_local('owner','lease')
    with runtime.run('owner-run',client='owner',lease='lease'):
        token=current_run.set('owner-run')
        try:
            with pytest.raises(ValueError):game.execute('observe',{},game.generation,None,None)
        finally:current_run.reset(token)


def test_reduced_observation_and_click_share_exact_pixel_mapping(local):
    import json
    from app.core import state
    runtime,native,_,_,calls=local
    raw=io.BytesIO();Image.new('RGB',(1600,1200),'white').save(raw,'PNG')
    original=runtime.host.request
    commands=[]
    def request(method,params=None):
        if method=='native.observe':return {'version':3,'bounds':{'x':200,'y':100,'width':800,'height':600},'data':base64.b64encode(raw.getvalue()).decode()}
        if method=='native.action':commands.append(params['command'])
        return original(method,params)
    runtime.host.request=request
    runtime.prepare_local('owner','lease')
    with runtime.run('owner-run',client='owner',lease='lease'):
        token=current_run.set('owner-run')
        try:
            with computer_tools.capture_scope(1024):result=json.loads(computer_tools.execute('computer_observe',{}))
            assert result['imageWidth']==1024 and result['imageHeight']==768 and result['coordinateSpace']=='image-pixels'
            payload=computer_tools.project([],state.load()['settings']['llm'])
            image=payload[-1]['content'][-1]['image_url']['url'].split(',')[1]
            assert Image.open(io.BytesIO(base64.b64decode(image))).size==(1024,768)
            result=json.loads(computer_tools.execute('computer_action',{'action':'click','x':512,'y':384,'version':3}))
            assert result['ok'] and commands==[{'action':'click','x':400,'y':300}]
            native.stop()
            result=json.loads(computer_tools.execute('computer_action',{'action':'click','x':512,'y':384,'version':3}))
            assert result['ok'] is False and len(commands)==1
        finally:current_run.reset(token)

@pytest.mark.parametrize('focused', [False, True])
def test_owner_minecraft_stop_tool_revokes_without_game_gate(local, monkeypatch, focused):
    import json
    from app.services import minecraft as module, capability
    runtime,native,_,_,calls=local
    native.stop();monkeypatch.setattr(module,'runtime',runtime)
    game=module.Minecraft();monkeypatch.setattr(module,'minecraft',game)
    game.connect(17643,'fixture-token','fixture-world','fixture-account',['game.observe'],'owner','lease')
    runtime.prepare_local('owner','lease')
    with runtime.run('owner-run',client='owner',lease='lease'):
        token=current_run.set('owner-run')
        try:
            runtime.focus=focused; game.actions=120
            monkeypatch.setattr(game,'gate',lambda *args: (_ for _ in ()).throw(AssertionError('stop must bypass game gate')))
            declared=next(row['function'] for row in computer_tools.declarations() if row['function']['name']=='minecraft_action')
            assert 'stop' in declared['parameters']['properties']['action']['enum']
            generation=game.generation
            result=json.loads(capability.execute_tool('minecraft_action',{'action':'stop'}))
            assert result.get('ok') is not False
            assert game.binding is None and game.permissions==set() and game.generation>generation
            assert calls[-1]=='minecraft.stop'
            assert json.loads(capability.execute_tool('minecraft_action',{'action':'stop'})).get('ok') is not False
        finally: current_run.reset(token)

@pytest.mark.parametrize('denial', ['remote','old-run','audience'])
def test_minecraft_stop_tool_cannot_be_invoked_by_external_or_stale_scope(local,monkeypatch,denial):
    import json
    from app.services import minecraft as module, capability
    runtime,native,_,_,calls=local
    native.stop();monkeypatch.setattr(module,'runtime',runtime)
    game=module.Minecraft();monkeypatch.setattr(module,'minecraft',game)
    game.connect(17643,'fixture-token','fixture-world','fixture-account',['game.observe'],'owner','lease')
    runtime.prepare_local('owner','lease')
    with runtime.run('owner-run',client='owner',lease='lease'):
        token=current_run.set('old-run' if denial=='old-run' else 'owner-run')
        try:
            if denial=='remote':runtime.activity['source']='qq'
            if denial=='audience':monkeypatch.setattr(checkpoint,'audience',lambda:'qq:fixture')
            count=len(calls)
            assert json.loads(capability.execute_tool('minecraft_action',{'action':'stop'}))['ok'] is False
            assert game.binding and game.permissions and len(calls)==count
        finally:current_run.reset(token)
