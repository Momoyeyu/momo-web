"""Durable intentions and observed receipts, separate from compacted conversation.

Restoring this journal never restores gameplay permission or replays commands.
"""
import hashlib
import json
import math
import re
import uuid
from ..core import db

STATUSES={'active','paused','completed','abandoned','blocked'}
class DispatchConflict(ValueError):pass
def scope(binding):
    return hashlib.sha256(json.dumps(binding,sort_keys=True).encode()).hexdigest()
def schema():
    with db.tx() as c:
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_goals(scope TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_tasks(scope TEXT NOT NULL,activity TEXT NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,activity,task_id))')
        # Early development journals used an in-process UI counter. Preserve their
        # facts, but use unique activity identities across subsequent app restarts.
        if 'generation' in {row['name'] for row in c.execute('PRAGMA table_info(minecraft_tasks)')}:
            c.execute('ALTER TABLE minecraft_tasks RENAME COLUMN generation TO activity')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_places(scope TEXT NOT NULL,dimension TEXT NOT NULL,chunk_x INTEGER NOT NULL,chunk_z INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,dimension,chunk_x,chunk_z))')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_goal_instances(scope TEXT PRIMARY KEY,goal_id TEXT NOT NULL)')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_task_goals(scope TEXT NOT NULL,activity TEXT NOT NULL,task_id TEXT NOT NULL,goal_id TEXT NOT NULL,progress TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(scope,activity,task_id))')
        c.execute('CREATE INDEX IF NOT EXISTS minecraft_goal_progress ON minecraft_task_goals(scope,goal_id,updated_at DESC)')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_dispatches(scope TEXT NOT NULL,activity TEXT NOT NULL,task_id TEXT NOT NULL,request TEXT NOT NULL,disposition TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,activity,task_id))')

def prepare_dispatch(binding, activity, command):
    """Write before transport. A pending/unknown command must never be resent."""
    task_id=command.get('taskId')
    if not isinstance(task_id,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',task_id):raise ValueError('Invalid task ID')
    request=json.dumps({'skill':command.get('skill'),'args':command.get('args',{})},sort_keys=True,ensure_ascii=False)
    if len(request)>64000:raise ValueError('Task request too large')
    schema();key=scope(binding)
    with db.tx() as c:
        old=c.execute('SELECT request,disposition FROM minecraft_dispatches WHERE scope=? AND activity=? AND task_id=?',(key,activity,task_id)).fetchone()
        if old:
            if old['request']!=request:raise DispatchConflict('Task identity conflict')
            if old['disposition']=='observed':return False
            if old['disposition']!='rejected':raise DispatchConflict('Task already dispatched; inspect its original receipt without replay')
        now=db.now_iso()
        c.execute('INSERT INTO minecraft_dispatches VALUES(?,?,?,?,?,?) ON CONFLICT(scope,activity,task_id) DO UPDATE SET disposition=excluded.disposition,updated_at=excluded.updated_at',(key,activity,task_id,request,'pending',now))
        task={'taskId':task_id,'skill':command.get('skill'),'state':'unknown','reason':'dispatch_unconfirmed','evidence':{}}
        c.execute('INSERT INTO minecraft_tasks VALUES(?,?,?,?,?) ON CONFLICT(scope,activity,task_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(key,activity,task_id,json.dumps(task),now))
    if not old:bind_task(binding,activity,task_id)
    return True

def dispatch_failed(binding, activity, task_id, *, rejected=False, reason='dispatch_unconfirmed'):
    schema();key=scope(binding)
    with db.tx() as c:
        # A real receipt may already have arrived through events or stop.
        row=c.execute('SELECT disposition FROM minecraft_dispatches WHERE scope=? AND activity=? AND task_id=?',(key,activity,task_id)).fetchone()
        if row is None or row['disposition']=='observed':return
        disposition='rejected' if rejected else 'unknown'
        c.execute('UPDATE minecraft_dispatches SET disposition=?,updated_at=? WHERE scope=? AND activity=? AND task_id=?',(disposition,db.now_iso(),key,activity,task_id))
        row=c.execute('SELECT data FROM minecraft_tasks WHERE scope=? AND activity=? AND task_id=?',(key,activity,task_id)).fetchone()
        task=json.loads(row['data'])
        task.update(state='failed' if rejected else 'unknown',reason=reason)
        c.execute('UPDATE minecraft_tasks SET data=?,updated_at=? WHERE scope=? AND activity=? AND task_id=?',(json.dumps(task),db.now_iso(),key,activity,task_id))

def history(binding, *, activity=None, task_id=None, limit=12):
    """Read original facts only; never contact a body, restore a grant or replay."""
    schema();where='t.scope=?';params=[scope(binding)]
    if activity is not None:where+=' AND t.activity=?';params.append(activity)
    if task_id is not None:where+=' AND t.task_id=?';params.append(task_id)
    rows=db.query('SELECT t.activity,t.data,d.request,d.disposition FROM minecraft_tasks t LEFT JOIN minecraft_dispatches d ON d.scope=t.scope AND d.activity=t.activity AND d.task_id=t.task_id WHERE '+where+' ORDER BY t.updated_at DESC,t.rowid DESC LIMIT ?',(*params,min(64,max(1,limit))))
    return [{**json.loads(row['data']),'activityId':row['activity'],**({'dispatch':row['disposition'],'request':json.loads(row['request'])} if row['request'] else {})} for row in reversed(rows)]
def goal(binding):
    schema()
    rows=db.query('SELECT data FROM minecraft_goals WHERE scope=?',(scope(binding),))
    return json.loads(rows[0]['data']) if rows else None

def validate_goal(value):
    allowed={'title','reason','source','expected','constraints','status','progress','next'}
    if not isinstance(value,dict) or set(value)-allowed or not {'title','reason','source','expected','status'} <= set(value):raise ValueError('Invalid game goal')
    if value['status'] not in STATUSES or value['source'] not in {'player','curiosity','aesthetic','help','social','survival','progress','rest'}:raise ValueError('Invalid game goal state')
    if any(not isinstance(v,str) or len(v)>1000 for v in value.values()) or not value['title'].strip():raise ValueError('Invalid game goal text')
    return value

def set_goal(binding, value):
    validate_goal(value)
    schema()
    key=scope(binding)
    with db.tx() as c:
        row=c.execute('SELECT data FROM minecraft_goals WHERE scope=?',(key,)).fetchone()
        previous=json.loads(row['data']) if row else None
        instance=c.execute('SELECT goal_id FROM minecraft_goal_instances WHERE scope=?',(key,)).fetchone()
        replacing=previous and (any(previous.get(k)!=value.get(k) for k in ('title','expected')) or previous['status'] in {'completed','abandoned'} and value['status'] in {'active','blocked'})
        if instance is None or replacing:c.execute('INSERT INTO minecraft_goal_instances VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET goal_id=excluded.goal_id',(key,uuid.uuid4().hex))
        c.execute('INSERT INTO minecraft_goals VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(key,json.dumps(value,ensure_ascii=False),db.now_iso()))
    return value

def bind_task(binding, activity, task_id):
    """Capture intent before dispatch. Reconciliation must not reassign an ID."""
    schema();key=scope(binding)
    with db.tx() as c:
        previous=c.execute('SELECT goal_id FROM minecraft_task_goals WHERE scope=? AND activity=? AND task_id=?',(key,activity,task_id)).fetchone()
        if previous:return previous['goal_id']
        row=c.execute('SELECT data FROM minecraft_goals WHERE scope=?',(key,)).fetchone()
        if not row or json.loads(row['data'])['status'] not in {'active','blocked'}:return None
        instance=c.execute('SELECT goal_id FROM minecraft_goal_instances WHERE scope=?',(key,)).fetchone()
        if instance is None:
            identity=uuid.uuid4().hex;c.execute('INSERT INTO minecraft_goal_instances VALUES(?,?)',(key,identity))
        else:identity=instance['goal_id']
        c.execute('INSERT INTO minecraft_task_goals VALUES(?,?,?,?,NULL,?)',(key,activity,task_id,identity,db.now_iso()))
        return identity

def _progress(task):
    if task.get('state') not in {'succeeded','failed','cancelled'}:return None
    gains={};placed={};mined={};positions=[];defeated=set();seen=set();pending=[(task.get('evidence',{}),0)];visited=0
    def resource(value):
        if not isinstance(value,str) or len(value)>1200:return None
        match=re.fullmatch(r'(?:Block\{)?([a-z0-9_.-]+:[a-z0-9_./-]+)(?:\}.*)?',value)
        return match[1] if match and len(match[1])<=128 else None
    while pending and visited<512:
        row,depth=pending.pop();visited+=1
        if depth>8:continue
        if isinstance(row,list):pending.extend((r,depth+1) for r in row);continue
        if not isinstance(row,dict):continue
        item=resource(row.get('item'));before,after=row.get('countBefore'),row.get('countAfter')
        if item and type(before) is int and type(after) is int and 0<=before<after:gains[item]=gains.get(item,0)+after-before
        block=resource(row.get('block'));sequence=row.get('serverBlockSeq')
        if block and type(sequence) is int and sequence>0 and all(type(row.get(axis)) is int for axis in ('x','y','z')):
            identity=(sequence,*(row[axis] for axis in ('x','y','z')))
            if identity not in seen:
                seen.add(identity);counts=mined if 'after' in row else placed;counts[block]=counts.get(block,0)+1
                if 'after' not in row:positions.append({'block':block,**{axis:row[axis] for axis in ('x','y','z')}})
        if row.get('targetAlive') is False and type(row.get('entityId')) is int:defeated.add(row['entityId'])
        pending.extend((value,depth+1) for value in row.values() if isinstance(value,(list,dict)))
    if not (gains or placed or mined or defeated):return None
    result={'taskId':task['taskId'],'skill':task.get('skill','plan'),'partial':task['state']!='succeeded'}
    dimension=task.get('dimension')
    if isinstance(dimension,str) and len(dimension)<=128 and re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]+',dimension):result['dimension']=dimension
    if gains:result['gains']=[{'item':item,'count':count} for item,count in sorted(gains.items())]
    if placed:result['placed']=[{'block':block,'count':count} for block,count in sorted(placed.items())]
    if mined:result['mined']=[{'block':block,'count':count} for block,count in sorted(mined.items())]
    if positions:result['positions']=positions[-4:]
    if defeated:result['defeated']=len(defeated)
    return result

def progress(binding, limit=8):
    schema();key=scope(binding)
    rows=db.query('SELECT t.progress FROM minecraft_task_goals t JOIN minecraft_goal_instances g ON g.scope=t.scope AND g.goal_id=t.goal_id WHERE t.scope=? AND t.progress IS NOT NULL ORDER BY t.updated_at DESC,t.rowid DESC LIMIT ?',(key,min(8,max(1,limit))))
    return [json.loads(row['progress']) for row in reversed(rows)]

def record(binding,activity,tasks):
    if len(tasks)>4096:raise ValueError('Too many task receipts')
    schema();changed=[]
    with db.tx() as c:
        for task in tasks:
            if not isinstance(task,dict) or not isinstance(task.get('taskId'),str) or len(task['taskId'])>80:raise ValueError('Invalid task receipt')
            if task.get('state') not in {'queued','running','paused','succeeded','failed','cancelled'}:raise ValueError('Invalid task state')
            if task['state']=='succeeded' and not task.get('evidence'):raise ValueError('Unverified task completion')
            data=json.dumps(task,sort_keys=True,ensure_ascii=False)
            if len(data)>64000:raise ValueError('Task evidence too large')
            old=c.execute('SELECT data FROM minecraft_tasks WHERE scope=? AND activity=? AND task_id=?',(scope(binding),activity,task['taskId'])).fetchone()
            if old and json.loads(old['data']).get('state') in {'succeeded','failed','cancelled'} and task['state'] in {'queued','running','paused'}:continue
            if old and old['data']==data:continue
            c.execute('INSERT INTO minecraft_tasks VALUES(?,?,?,?,?) ON CONFLICT(scope,activity,task_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(scope(binding),activity,task['taskId'],data,db.now_iso()))
            c.execute("UPDATE minecraft_dispatches SET disposition='observed',updated_at=? WHERE scope=? AND activity=? AND task_id=?",(db.now_iso(),scope(binding),activity,task['taskId']))
            milestone=_progress(task)
            if milestone is not None:c.execute('UPDATE minecraft_task_goals SET progress=?,updated_at=? WHERE scope=? AND activity=? AND task_id=?',(json.dumps(milestone,ensure_ascii=False),db.now_iso(),scope(binding),activity,task['taskId']))
            changed.append(task)
    return changed

def reconcile(binding, *, activity=None):
    """Close unconfirmed execution records without inventing a gameplay outcome.

    A reconnect restores intentions only. It never resumes or replays these tasks.
    Known terminal receipts and any partial evidence remain intact.
    """
    schema()
    with db.tx() as c:
        c.execute("UPDATE minecraft_dispatches SET disposition='unknown',updated_at=? WHERE scope=? AND disposition='pending'"+(' AND activity=?' if activity is not None else ''),(db.now_iso(),scope(binding),*([activity] if activity is not None else [])))
        for row in c.execute('SELECT activity,task_id,data FROM minecraft_tasks WHERE scope=?',(scope(binding),)).fetchall():
            if activity is not None and row['activity'] != activity:continue
            task=json.loads(row['data'])
            if task.get('state') not in {'queued','running','paused'}:continue
            task={**task,'state':'unknown','reason':'activity_ended_without_terminal_receipt'}
            c.execute('UPDATE minecraft_tasks SET data=?,updated_at=? WHERE scope=? AND activity=? AND task_id=?',
                      (json.dumps(task,ensure_ascii=False),db.now_iso(),scope(binding),row['activity'],row['task_id']))

def recent(binding,limit=12):
    schema()
    return [json.loads(row['data']) for row in reversed(db.query('SELECT data FROM minecraft_tasks WHERE scope=? ORDER BY updated_at DESC LIMIT ?',(scope(binding),min(64,max(1,limit)))))]

def observe_visit(binding, observation):
    """Remember places actually visited, with only the bridge's visible landmarks.

    This is a bounded exploration notebook, never a terrain/resource scanner.
    """
    if any(observation.get(k)!=v for k,v in binding.items()):return
    dimension=observation.get('dimension','')
    if not isinstance(dimension,str) or not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]{1,100}',dimension):return
    xyz=[observation.get(k) for k in ('x','y','z')]
    if any(type(v) not in (int,float) or not math.isfinite(v) or abs(v)>30_000_000 for v in xyz):return
    x,y,z=xyz
    landmarks=[]
    for block in observation.get('visibleBlocks',[])[:8]:
        name=block.get('block','')
        coords=[block.get(k) for k in ('x','y','z')]
        if not isinstance(name,str) or len(name)>128 or not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]+',name):continue
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in coords):continue
        if sum((v-p)**2 for v,p in zip(coords,xyz))>64:continue
        if name in {'minecraft:grass_block','minecraft:dirt','minecraft:stone','minecraft:short_grass'}:continue
        landmarks.append({'block':name,**dict(zip(('x','y','z'),coords))})
    place={'dimension':dimension,'x':round(x,1),'y':round(y,1),'z':round(z,1),'landmarks':landmarks}
    schema();key=scope(binding)
    with db.tx() as c:
        c.execute('INSERT INTO minecraft_places VALUES(?,?,?,?,?,?) ON CONFLICT(scope,dimension,chunk_x,chunk_z) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
                  (key,dimension,math.floor(x/16),math.floor(z/16),json.dumps(place),db.now_iso()))
        c.execute('DELETE FROM minecraft_places WHERE scope=? AND rowid NOT IN (SELECT rowid FROM minecraft_places WHERE scope=? ORDER BY updated_at DESC LIMIT 1024)',(key,key))

def explored(binding,limit=8):
    schema()
    return [json.loads(row['data']) for row in db.query('SELECT data FROM minecraft_places WHERE scope=? ORDER BY updated_at DESC LIMIT ?',
                                                       (scope(binding),min(32,max(1,limit))))]
