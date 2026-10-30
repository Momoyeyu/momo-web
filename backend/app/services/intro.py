"""Durable first-run milestones. UI progress never grants runtime capabilities."""
from __future__ import annotations
import hashlib
import json
from ..core import db, state, llm

KEY='intro_v1'
TOOL={'type':'function','function':{'name':'intro_connection_check','description':'Confirm this connection check by calling this function with ok=true.','parameters':{'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok'],'additionalProperties':False}}}


def _read(c):
    row=c.execute('SELECT value FROM meta WHERE key=?',(KEY,)).fetchone()
    return json.loads(row['value']) if row else None


def _save(c,value):
    c.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',(KEY,json.dumps(value)))


def fingerprint(config):
    return hashlib.sha256(json.dumps(config,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def initialize():
    from . import onboarding
    old=onboarding.status()
    with db.tx() as c:
        if _read(c) is not None:return
        legacy=old['stage'] in {'completed','skipped','legacy'}
        resumed=old['stage'] in {'asking','clarifying'}
        value={'version':1,'phase':'completed' if legacy else 'naming' if resumed else 'setup','legacy':legacy,'languageConfirmed':legacy or resumed}
        if resumed:value['configuration']=fingerprint(state.load()['settings']['llm'])
        _save(c,value)


def status():
    initialize()
    with db.tx() as c:value=dict(_read(c))
    return {k:v for k,v in value.items() if k!='configuration'} | {'configurationValid':value.get('configuration')==fingerprint(state.load()['settings']['llm'])}


def phase():
    # Initialization is explicit at application startup, not inside a DB callback.
    with db._lock:value=_read(db.conn())
    return value['phase'] if value else 'completed'


def restricted():
    return phase()!='completed'


def can_boot():
    with db.tx() as c:value=_read(c)
    if value is None or value['phase']=='completed':return True
    return value['phase'] in {'await_boot','naming'} and value.get('configuration')==fingerprint(state.load()['settings']['llm'])


def confirm_language(lang):
    if lang not in {'zh','en','ja'}:raise ValueError('Invalid language')
    initialize()
    with db.tx() as c:
        value=_read(c)
        if value['phase']!='setup':raise ValueError('Language step already completed')
        current=state.load();current['settings']['general'].update(lang=lang,chatLang='auto')
        state.write_state(current)
        value['languageConfirmed']=True
        _save(c,value)
    return status()


def verify(config):
    initialize()
    with db.tx() as c:
        value=_read(c)
        if not value.get('languageConfirmed'):raise ValueError('Confirm interface language first')
        if value['phase'] not in {'setup','await_boot','naming'}:raise ValueError('Configuration step is not active')
    if not config.get('url','').strip() or not config.get('model','').strip():raise ValueError('Configure model API and model name')
    stamp=fingerprint(config)
    if stamp!=fingerprint(state.load()['settings']['llm']):raise ValueError('Save the current configuration first')
    result=llm.chat_completion(config,[{'role':'user','content':'Call intro_connection_check with ok=true. This is only a connection test.'}],tools=[TOOL])
    try:
        calls=result.get('tool_calls') or []
        if len(calls)!=1 or calls[0]['function']['name']!='intro_connection_check' or json.loads(calls[0]['function']['arguments'])!={'ok':True}:
            raise ValueError('Invalid connection check result')
    except (AssertionError,ValueError,KeyError,TypeError) as error:
        raise ValueError('Model must support tool calls') from error
    with db.tx() as c, state.configuration_lock:
        value=_read(c)
        if stamp!=fingerprint(state.load()['settings']['llm']) or value['phase'] not in {'setup','await_boot','naming'}:raise ValueError('Configuration changed; check again')
        value['configuration']=stamp
        if value['phase']=='setup':value['phase']='await_boot'
        _save(c,value)
    return status()


def name_saved(c,memory_id):
    value=_read(c)
    if value is None or value['phase']=='completed':return
    value.update(phase='return_title',memoryId=memory_id)
    _save(c,value)


def finish():
    from .coordinator import runtime
    initialize()
    with runtime.condition:
        if runtime.mode!='dormant' or runtime.owner or runtime.active or runtime.presentation:raise ValueError('Wait for the first activity to stop')
        with db.tx() as c:
            value=_read(c)
            if value['phase']=='completed':return {'phase':'completed'}
            if value['phase']!='return_title':raise ValueError('Remember the name first')
            # Rebuild summaries from eligible ledger rows; invalidate in-flight compression.
            c.execute("UPDATE sessions SET summary='',summary_cursor=-1,summary_version=summary_version+1 WHERE id='live'")
            value['phase']='completed';_save(c,value)
    return status()


def did_boot():
    with db.tx() as c:
        value=_read(c)
        if value and value['phase']=='await_boot':
            value['phase']='naming';_save(c,value)


def invalidate_configuration(attempted_config):
    with db.tx() as c:
        value=_read(c)
        if value and value['phase'] in {'await_boot','naming'} and value.get('configuration')==fingerprint(attempted_config):
            value.pop('configuration',None);_save(c,value)
