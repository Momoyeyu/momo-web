"""Durable intentions and observed receipts, separate from compacted conversation.

Restoring this journal never restores gameplay permission or replays commands.
"""
import hashlib
import json
from ..core import db

STATUSES={'active','paused','completed','abandoned','blocked'}
def scope(binding):
    return hashlib.sha256(json.dumps(binding,sort_keys=True).encode()).hexdigest()
def schema():
    with db.tx() as c:
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_goals(scope TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_tasks(scope TEXT NOT NULL,generation INTEGER NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,generation,task_id))')
def goal(binding):
    schema()
    rows=db.query('SELECT data FROM minecraft_goals WHERE scope=?',(scope(binding),))
    return json.loads(rows[0]['data']) if rows else None

def set_goal(binding, value):
    allowed={'title','reason','source','expected','constraints','status','progress','next'}
    if not isinstance(value,dict) or set(value)-allowed or not {'title','reason','source','expected','status'} <= set(value):raise ValueError('Invalid game goal')
    if value['status'] not in STATUSES or value['source'] not in {'player','curiosity','aesthetic','help','social','survival','progress','rest'}:raise ValueError('Invalid game goal state')
    if any(not isinstance(v,str) or len(v)>1000 for v in value.values()) or not value['title'].strip():raise ValueError('Invalid game goal text')
    schema()
    with db.tx() as c:c.execute('INSERT INTO minecraft_goals VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(scope(binding),json.dumps(value,ensure_ascii=False),db.now_iso()))
    return value

def record(binding,generation,tasks):
    schema();changed=[]
    with db.tx() as c:
        for task in tasks[:256]:
            if not isinstance(task,dict) or not isinstance(task.get('taskId'),str) or len(task['taskId'])>80:raise ValueError('Invalid task receipt')
            if task.get('state') not in {'queued','running','paused','succeeded','failed','cancelled'}:raise ValueError('Invalid task state')
            if task['state']=='succeeded' and not task.get('evidence'):raise ValueError('Unverified task completion')
            data=json.dumps(task,sort_keys=True,ensure_ascii=False)
            if len(data)>64000:raise ValueError('Task evidence too large')
            old=c.execute('SELECT data FROM minecraft_tasks WHERE scope=? AND generation=? AND task_id=?',(scope(binding),generation,task['taskId'])).fetchone()
            if old and old['data']==data:continue
            c.execute('INSERT INTO minecraft_tasks VALUES(?,?,?,?,?) ON CONFLICT(scope,generation,task_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',(scope(binding),generation,task['taskId'],data,db.now_iso()))
            changed.append(task)
    return changed

def recent(binding,limit=12):
    schema()
    return [json.loads(row['data']) for row in reversed(db.query('SELECT data FROM minecraft_tasks WHERE scope=? ORDER BY updated_at DESC LIMIT ?',(scope(binding),min(64,max(1,limit)))))]
