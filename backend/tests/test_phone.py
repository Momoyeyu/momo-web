from app.core import db
from app.services.coordinator import runtime
from app.services import phone


def test_empty_phone_and_account_isolation(monkeypatch):
    runtime.schema()
    monkeypatch.setattr(phone.social,'get',lambda p:{'accountId':'test','expectedSelfId':'10001','enabled':False})
    runtime.enqueue('qq','test','one','pending message',self_id='10001',peer_id='20001')
    runtime.enqueue('qq','test','two','other account secret',self_id='99999',peer_id='20002')
    a=phone.snapshot('20001')
    assert a['pending']==1
    assert [c['id'] for c in a['conversations']]==['20001']
    assert [m['text'] for m in a['messages']]==['pending message']
    phone.snapshot('20001')
    assert phone.snapshot()['pending']==1 # viewing does not consume backlog


def test_phone_does_not_show_unacknowledged_reply(monkeypatch):
    from app.services import checkpoint
    runtime.schema()
    monkeypatch.setattr(phone.social,'get',lambda p:{'accountId':'test','expectedSelfId':'10001','enabled':True})
    row=runtime.enqueue('qq','test','one','question',self_id='10001',peer_id='20001')
    gen=checkpoint.generation()
    checkpoint.begin_turn('question',gen,'t',run_id=row['run_id'],source='qq')
    checkpoint.append_sentence('not sent',gen,'t')
    assert len(phone.snapshot('20001')['messages'])==1


def test_second_plugin_projection_and_disposal(monkeypatch):
    monkeypatch.setattr(phone.social,'get',lambda p:{'accountId':'test','expectedSelfId':'','enabled':False})
    def view(peer,before):
        return {'apps':[{'id':'test-notes','provider':'notes','name':'Notes','enabled':True,'pending':0}], 'pending':0,'accountKey':'notes','messages':[],'conversations':[],'operations':[],'hasMore':False,'nextBefore':None,'activity':None}
    dispose=phone.register_app('test-notes',view)
    try:
        result=phone.snapshot(app='test-notes')
        assert {a['id'] for a in result['apps']}=={'momo-qq','test-notes'}
        assert result['accountKey']=='notes'
    finally:dispose()
    assert {a['id'] for a in phone.snapshot()['apps']}=={'momo-qq'}


def test_old_account_operation_does_not_leak(monkeypatch):
    import json
    runtime.schema()
    monkeypatch.setattr(phone.social,'get',lambda p:{'accountId':'test','expectedSelfId':'10001','enabled':True})
    with db.tx() as c:
        c.execute('INSERT INTO outbox(command_id,run_id,epoch,status,payload,at) VALUES(?,?,?,?,?,?)',('old','r',1,'unknown',json.dumps({'accountId':'test','peerId':'20001','selfId':'99999'}),'t'))
    assert phone.snapshot('20001')['operations']==[]


def test_proactive_text_requires_real_receipt(monkeypatch):
    import json
    runtime.schema()
    monkeypatch.setattr(phone.social,'get',lambda p:{'accountId':'test','expectedSelfId':'10001','enabled':True})
    payload={'accountId':'test','selfId':'10001','peerId':'20001','displayText':'Actual submitted text','action':'private.send'}
    with db.tx() as c:
        c.execute('INSERT INTO outbox(command_id,run_id,epoch,status,payload,at) VALUES(?,?,?,?,?,?)',('sent','r',1,'pending',json.dumps(payload),'t'))
    assert phone.snapshot('20001')['messages']==[]
    with db.tx() as c:c.execute("UPDATE outbox SET status='completed' WHERE command_id='sent'")
    result=phone.snapshot('20001')
    assert result['conversations'][0]['id']=='20001'
    assert result['messages'][0]['text']=='Actual submitted text'
