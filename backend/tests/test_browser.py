from unittest.mock import patch, MagicMock
import pytest
from app.services.browser import Browser, BrowserError


def test_permissions_never_upgrade_observe_to_interact():
    b = Browser()
    b.permissions = {'observe'}
    b.epoch = 1
    b.fingerprint = 'proof'
    with patch('app.services.browser.runtime') as runtime, patch.object(b,'gate',return_value='proof'):
        runtime.epoch = 1
        with pytest.raises(BrowserError,match='capability denied'):
            b.execute({'action':'click'},1,0,'client','lease')
        runtime.host.request.assert_not_called()


def test_revoke_invalidates_generation_before_host_stop():
    b = Browser()
    b.permissions = {'observe','interact'}
    with patch('app.services.browser.runtime') as runtime:
        def ack(*args,**kwargs):
            assert b.generation == 1
            assert not b.permissions
            return {'stopped':True}
        runtime.host.request.side_effect = ack
        assert b.stop()['stopped']


def test_stale_generation_rejects_before_dispatch():
    b = Browser()
    b.permissions = {'observe'}
    b.epoch = 1
    b.fingerprint = 'proof'
    with patch('app.services.browser.runtime') as runtime, patch.object(b,'gate',return_value='proof'):
        runtime.epoch = 1
        with pytest.raises(BrowserError): b.execute({'action':'observe'},None,99,'client','lease')
        runtime.host.request.assert_not_called()


def configured():
    b=Browser(); b.permissions={'observe'}; b.allowedHosts=['example.org']; b.epoch=1; b.fingerprint='proof'
    return b


def test_open_reads_allowed_scope_and_returns_screenshot_without_interact():
    b=configured()
    with patch('app.services.browser.runtime') as runtime, patch.object(b,'gate',return_value='proof'), patch('app.services.browser.browser_fetch.fetch') as fetch:
        runtime.epoch=1
        runtime.host.request.return_value={'data':'png','version':1}
        fetch.return_value=('<h1>External</h1>','https://example.org/')
        result=b.open('https://example.org/',0,'client','lease')
        assert result['data']=='png'
        assert fetch.call_args.args[1]==['example.org']
        assert runtime.host.request.call_args.args[1]['command']['action']=='load'
        assert b.fetches==1


def test_revoke_during_fetch_prevents_renderer_dispatch():
    b=configured()
    with patch('app.services.browser.runtime') as runtime, patch.object(b,'gate',return_value='proof'), patch('app.services.browser.browser_fetch.fetch') as fetch:
        runtime.epoch=1
        def received(*args):
            b.stop(notify=False)
            return '<h1>Late</h1>','https://example.org/'
        fetch.side_effect=received
        with pytest.raises(BrowserError,match='revoked'): b.open('https://example.org/',0,'client','lease')
        runtime.host.request.assert_not_called()


def test_oversize_page_never_reaches_renderer():
    b=configured()
    with patch('app.services.browser.runtime') as runtime, patch.object(b,'gate',return_value='proof'), patch('app.services.browser.browser_fetch.fetch',return_value=('x'*100001,'https://example.org/')):
        runtime.epoch=1
        with pytest.raises(BrowserError,match='budget'): b.open('https://example.org/',0,'client','lease')
        runtime.host.request.assert_not_called()


def test_internal_tool_can_present_its_own_preamble_only():
    from app.services.computer import computer
    from app.services.minecraft import minecraft
    b=Browser()
    with patch('app.services.browser.runtime') as runtime, patch('app.services.computer_tools.require_local',return_value='run'), patch('app.services.browser.vision.require_enabled'), patch('app.services.browser.state.load',return_value={'settings':{'llm':{}}}), patch.object(computer,'observing',False), patch.object(minecraft,'binding',None):
        runtime.started=True; runtime.mode='meeting'
        runtime.focus=runtime.restoring=runtime.interrupt_hold=False
        runtime.active='run'; runtime.presentation={'runId':'run'}
        assert b.gate(None,None)
        runtime.presentation={'runId':'other'}
        with pytest.raises(BrowserError,match='attention'): b.gate(None,None)
