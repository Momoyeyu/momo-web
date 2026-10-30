"""Owner-only phone projections of the existing inbox/ledger; no execution surface."""
import json

from ..core import db
from .social import social
from .coordinator import runtime

PENDING = ('queued','held_focus','held_inactive','held_paused','held_interrupt','processing')


def qq_snapshot(peer=None, before=None):
    runtime.schema()
    account = social.get('qq')
    if not account['enabled']:
        return {'apps':[], 'accountKey':'', 'pending':0, 'conversations':[], 'messages':[], 'operations':[], 'hasMore':False, 'nextBefore':None, 'activity':runtime.snapshot()['activity']}
    # Only the currently bound account; never merge a previous login's messages.
    identity = account.get('expectedSelfId') or ''
    clause = "source='qq' AND account_id=? AND self_id=?"
    params = (account['accountId'], identity)
    latest = db.query(f"SELECT peer_id,MAX(seq) AS newest,SUM(status IN ('queued','held_focus','held_inactive','held_paused','held_interrupt','processing')) AS pending FROM inbox WHERE {clause} GROUP BY peer_id ORDER BY newest DESC LIMIT 100",params) if identity else []
    conversations = {}
    for c in latest:
        row = db.query('SELECT text FROM inbox WHERE seq=?',(c['newest'],))[0]
        key=c['peer_id']
        conversations[key]={'id':key,'kind':'group' if key.startswith('group:') else 'private','pending':int(c['pending']),'preview':row['text'][:120]}
    outgoing=[]
    if identity:
        for row in db.query("SELECT command_id,payload,at FROM outbox WHERE status IN ('completed','delivered') ORDER BY at DESC LIMIT 100"):
            payload=json.loads(row['payload'])
            if (payload.get('accountId')==account['accountId'] and payload.get('selfId')==identity
                and payload.get('displayText') and payload.get('peerId')):
                key=payload['peerId']
                conversations.setdefault(key,{'id':key,'kind':'group' if key.startswith('group:') else 'private','pending':0,'preview':payload['displayText'][:120]})
                if key==peer and before is None:
                    outgoing.append({'id':row['command_id'],'text':payload['displayText'],'direction':'out','speaker':'momo','status':'delivered','at':row['at']})
    pending = db.query(f"SELECT COUNT(*) AS n FROM inbox WHERE {clause} AND status IN ('queued','held_focus','held_inactive','held_paused','held_interrupt','processing')",params)[0]['n'] if identity else 0
    selected = [dict(r) for r in db.query(f"SELECT * FROM inbox WHERE {clause} AND peer_id=? AND seq<? ORDER BY seq DESC LIMIT 31",(*params,peer,before if before is not None else 9223372036854775807))] if identity and peer else []
    page=selected[:30]
    messages=[]
    for row in reversed(page):
        messages.append({'id':row['id'],'text':row['text'],'direction':'in','speaker':row['sender_id'] or row['peer_id'],'status':row['status'],'at':row['at']})
        for out in db.query("SELECT * FROM messages WHERE run_id=? AND role='assistant' AND visible=1 ORDER BY seq",(row['run_id'],)):
            messages.append({'id':out['event_id'],'text':out['display_text'] or out['text'],'direction':'out','speaker':'momo','status':'delivered','at':out['at']})
    messages.extend(reversed(outgoing))
    messages.sort(key=lambda m:m["at"])
    operations=[]
    if peer:
        for row in db.query('SELECT command_id,status,payload FROM outbox ORDER BY at DESC LIMIT 100'):
            payload=json.loads(row['payload'])
            if payload.get('accountId')==account['accountId'] and payload.get('peerId')==peer and payload.get('selfId')==identity:
                operations.append({'id':row['command_id'],'status':row['status'],'action':payload.get('action',payload.get('method',''))})
    return {'apps':[{'id':'momo-qq','provider':'qq','name':'QQ','enabled':account['enabled'],'pending':int(pending)}],
            'accountKey':identity,'pending':int(pending),
            'conversations':list(conversations.values())[:100], 'messages':messages,
            'operations':operations[:10], 'hasMore':len(selected)>30,
            'nextBefore':page[-1]['seq'] if len(selected)>30 else None,
            'activity':runtime.snapshot()['activity']}


# Reviewed extensions register a projection reader; this registry never executes
# actions or grants permissions. Disposal removes the tile and its projections.
_providers = {}
def register_app(app_id, reader):
    if app_id in _providers: raise ValueError('Duplicate phone app')
    _providers[app_id] = reader
    def dispose():
        if _providers.get(app_id) is reader: _providers.pop(app_id, None)
    return dispose

register_app('momo-qq', qq_snapshot)

def snapshot(peer=None, before=None, app='momo-qq'):
    apps=[]; total=0; selected=None
    for app_id, reader in list(_providers.items()):
        view=reader(peer if app_id==app else None,before if app_id==app else None)
        apps.extend(view['apps']); total+=view['pending']
        if app_id==app: selected=view
    selected=selected or {'accountKey':'','conversations':[],'messages':[],'operations':[],'hasMore':False,'nextBefore':None,'activity':runtime.snapshot()['activity']}
    activity=selected['activity']
    if activity:
        activity=dict(activity)
        rows=db.query('SELECT peer_id FROM inbox WHERE run_id=?',(activity['runId'],))
        if rows: activity['peerId']=rows[0]['peer_id']
        elif runtime.activity and runtime.activity.get('peerId'):activity['peerId']=runtime.activity['peerId']
    last=runtime.phone_activity()
    if last:
        source=last.get('toolSource') or last['source']
        if not any(a['provider']==source and a['enabled'] for a in apps):
            last=None
        else:
            rows=db.query('SELECT peer_id FROM inbox WHERE run_id=?',(last['runId'],))
            if rows and not last.get('peerId'):last['peerId']=rows[0]['peer_id']
    return {**selected,'apps':apps,'pending':total,'activity':activity,'lastActivity':last}
