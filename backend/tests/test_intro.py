import json
import pytest
from app.core import db, state, llm
from app.services import intro, onboarding, checkpoint
from app.services.coordinator import Coordinator, CoordinationError
from conftest import add_turn


def config():
    s=state.load();s['settings']['llm']={'url':'https://example.test','key':'test-private','model':'test','thinking':False};state.write_state(s)
    return s['settings']['llm']


def health(monkeypatch):
    monkeypatch.setattr(llm,'chat_completion',lambda *a,**k:{'tool_calls':[{'function':{'name':'intro_connection_check','arguments':'{"ok":true}'}}]})


def ready(monkeypatch):
    assert intro.status()['phase']=='setup'
    cfg=config();intro.confirm_language('en');health(monkeypatch);intro.verify(cfg)
    return cfg


def test_language_and_model_checkpoints(monkeypatch):
    ready(monkeypatch)
    assert intro.status()['phase']=='await_boot'
    assert state.load()['settings']['general']['chatLang']=='auto'
    assert intro.status()['languageConfirmed']
    assert 'test-private' not in json.dumps(intro.status())
    assert intro.status()['configurationValid']


def test_failed_and_stale_health_cannot_complete(monkeypatch):
    intro.status();cfg=config();intro.confirm_language('zh')
    def changed(*a,**k):
        s=state.load();s['settings']['llm']['model']='other';state.write_state(s)
        return {'tool_calls':[{'function':{'name':'intro_connection_check','arguments':'{"ok":true}'}}]}
    monkeypatch.setattr(llm,'chat_completion',changed)
    with pytest.raises(ValueError):intro.verify(cfg)
    assert intro.status()['phase']=='setup'
    monkeypatch.setattr(llm,'chat_completion',lambda *a,**k:{'content':'OK'})
    with pytest.raises(ValueError):intro.verify(state.load()['settings']['llm'])
    assert intro.status()['phase']=='setup'


def test_boot_is_not_allowed_before_checkpoint(monkeypatch):
    intro.status()
    core=Coordinator()
    with pytest.raises(CoordinationError,match='configuration'):
        core.enter('intro-client')


def test_name_refusal_and_many_clarifications_never_skip(monkeypatch):
    ready(monkeypatch)
    onboarding.opening(None)
    monkeypatch.setattr(llm,'chat_completion',lambda *a,**k:{'tool_calls':[{'function':{'name':'first_meeting_result','arguments':'{"action":"skip","name":"","quote":""}'}}]})
    for _ in range(4):
        onboarding.resolve('不想说，聊游戏',checkpoint.generation())
        assert onboarding.status()['stage'] in {'asking','clarifying'}
        assert intro.status()['phase']!='return_title'


def test_name_memory_checkpoint_survives_unobserved_reply(monkeypatch):
    ready(monkeypatch);onboarding.opening(None)
    monkeypatch.setattr(llm,'chat_completion',lambda *a,**k:{'tool_calls':[{'function':{'name':'first_meeting_result','arguments':'{"action":"name","name":"Star","quote":"call me Star"}'}}]})
    gen=checkpoint.generation();at=db.now_iso();checkpoint.begin_turn('call me Star',gen,at)
    onboarding.resolve('call me Star',gen,at)
    onboarding.settle_reply(at)
    assert intro.status()['phase']=='return_title'
    assert len(db.query('SELECT * FROM memories WHERE pinned=0'))==1
    assert len(db.query('SELECT * FROM memory_sources'))>=1
    assert 'Star' in db.query('SELECT content FROM memories WHERE pinned=0')[0]['content']
    onboarding.resolve('call me Star',gen)
    assert len(db.query('SELECT * FROM memories WHERE pinned=0'))==1


def test_finish_requires_settled_title_and_never_reasks(monkeypatch):
    ready(monkeypatch)
    with pytest.raises(ValueError):intro.finish()
    with db.tx() as c:
        intro.name_saved(c,'saved-memory')
    from app.services.coordinator import runtime
    monkeypatch.setattr(runtime,'mode','meeting')
    with pytest.raises(ValueError):intro.finish()
    monkeypatch.setattr(runtime,'mode','dormant');monkeypatch.setattr(runtime,'owner',None)
    intro.finish();assert intro.status()['phase']=='completed'


def test_existing_relationship_is_grandfathered():
    add_turn('hello','hello')
    assert intro.status()['phase']=='completed'
    assert intro.status()['legacy']

def test_late_failed_probe_cannot_erase_newer_configuration(monkeypatch):
    original=ready(monkeypatch)
    from fastapi.testclient import TestClient
    from app.main import app
    def late_failure(*a,**k):
        s=state.load();s['settings']['llm']['model']='new-model';state.write_state(s)
        with db.tx() as c:
            value=intro._read(c);value['configuration']=intro.fingerprint(s['settings']['llm']);intro._save(c,value)
        raise llm.LlmError('old request timed out')
    monkeypatch.setattr(llm,'chat_completion',late_failure)
    assert TestClient(app).post('/api/intro/verify',json=original).status_code==409
    assert intro.status()['configurationValid']

def test_boot_rechecks_configuration_after_host_settlement(monkeypatch):
    ready(monkeypatch)
    core=Coordinator();core.schema()
    monkeypatch.setattr(core,'_revoke',lambda *a:None)
    def change_config():
        s=state.load();s['settings']['llm']['model']='changed-during-boot';state.write_state(s)
    monkeypatch.setattr(core,'_grant',change_config)
    monkeypatch.setattr(core,'_schedule_qq_restore',lambda:None)
    with pytest.raises(CoordinationError):core.enter('intro-race-owner')
    assert core.owner is None
