"""Durable intentions and observed receipts, separate from compacted conversation.

Restoring this journal never restores gameplay permission or replays commands.
"""
import hashlib
import json
import math
import re
from ..core import db

STATUSES={'active','paused','completed','abandoned','blocked'}
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
    with db.tx() as c:c.execute('INSERT INTO minecraft_goals VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(scope(binding),json.dumps(value,ensure_ascii=False),db.now_iso()))
    return value

def record(binding,activity,tasks):
    schema();changed=[]
    with db.tx() as c:
        for task in tasks[:256]:
            if not isinstance(task,dict) or not isinstance(task.get('taskId'),str) or len(task['taskId'])>80:raise ValueError('Invalid task receipt')
            if task.get('state') not in {'queued','running','paused','succeeded','failed','cancelled'}:raise ValueError('Invalid task state')
            if task['state']=='succeeded' and not task.get('evidence'):raise ValueError('Unverified task completion')
            data=json.dumps(task,sort_keys=True,ensure_ascii=False)
            if len(data)>64000:raise ValueError('Task evidence too large')
            old=c.execute('SELECT data FROM minecraft_tasks WHERE scope=? AND activity=? AND task_id=?',(scope(binding),activity,task['taskId'])).fetchone()
            if old and old['data']==data:continue
            c.execute('INSERT INTO minecraft_tasks VALUES(?,?,?,?,?) ON CONFLICT(scope,activity,task_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(scope(binding),activity,task['taskId'],data,db.now_iso()))
            changed.append(task)
    return changed

def reconcile(binding, *, activity=None):
    """Close unconfirmed execution records without inventing a gameplay outcome.

    A reconnect restores intentions only. It never resumes or replays these tasks.
    Known terminal receipts and any partial evidence remain intact.
    """
    schema()
    with db.tx() as c:
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
