"""Durable intentions and observed receipts, separate from compacted conversation.

Restoring this journal never restores gameplay permission or replays commands.
"""
import hashlib
import json
import math
import re
import uuid
import time
from datetime import datetime, timezone
from ..core import db

STATUSES={'active','paused','completed','abandoned','blocked'}
class DispatchConflict(ValueError):pass
class RejectedDispatchConflict(DispatchConflict):pass
def scope(binding):
    return hashlib.sha256(json.dumps(binding,sort_keys=True).encode()).hexdigest()
def schema():
    with db.tx() as c:
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_goals(scope TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_tasks(scope TEXT NOT NULL,activity TEXT NOT NULL,task_id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,activity,task_id))')
        c.execute('CREATE INDEX IF NOT EXISTS minecraft_task_time ON minecraft_tasks(scope,updated_at)')
        # Early development journals used an in-process UI counter. Preserve their
        # facts, but use unique activity identities across subsequent app restarts.
        if 'generation' in {row['name'] for row in c.execute('PRAGMA table_info(minecraft_tasks)')}:
            c.execute('ALTER TABLE minecraft_tasks RENAME COLUMN generation TO activity')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_places(scope TEXT NOT NULL,dimension TEXT NOT NULL,chunk_x INTEGER NOT NULL,chunk_z INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope,dimension,chunk_x,chunk_z))')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_goal_instances(scope TEXT PRIMARY KEY,goal_id TEXT NOT NULL)')
        c.execute('CREATE TABLE IF NOT EXISTS minecraft_task_goals(scope TEXT NOT NULL,activity TEXT NOT NULL,task_id TEXT NOT NULL,goal_id TEXT NOT NULL,progress TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(scope,activity,task_id))')
        c.execute('CREATE INDEX IF NOT EXISTS minecraft_goal_progress ON minecraft_task_goals(scope,goal_id,updated_at DESC)')
        c.execute('CREATE INDEX IF NOT EXISTS minecraft_goal_intents ON minecraft_task_goals(scope,goal_id)')
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
            if old['request']!=request:
                if old['disposition']=='rejected':raise RejectedDispatchConflict('Known rejected task ID; use a new taskId for corrected arguments')
                raise DispatchConflict('Task identity conflict')
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

def _planned_build_cells(arguments):
    if not isinstance(arguments,dict) or ('cells' in arguments)==('box' in arguments):return []
    if 'cells' in arguments:return arguments['cells'] if isinstance(arguments['cells'],list) else []
    box=arguments['box']
    if not isinstance(box,dict) or set(box)-{'x','y','z','width','height','length','block','mode'}:return []
    if any(type(box.get(k)) is not int for k in ('x','y','z','width','height','length')):return []
    x,y,z,w,h,l=(box[k] for k in ('x','y','z','width','height','length'))
    if not all(1<=size<=16 for size in (w,h,l)) or not (-30000000<=x<=x+w-1<=30000000 and -64<=y<=y+h-1<=319 and -30000000<=z<=z+l-1<=30000000):return []
    mode=box.get('mode','solid');block=box.get('block')
    if mode not in ('solid','walls') or not isinstance(block,str) or not 3<=len(block)<=128 or any(ord(c)<32 for c in block):return []
    count=(w*l-max(0,w-2)*max(0,l-2) if mode=='walls' else w*l)*h
    if count>32:return []
    return [{'x':x+dx,'y':y+dy,'z':z+dz,'block':block} for dx in range(w) for dy in range(h) for dz in range(l)
            if mode!='walls' or dx in (0,w-1) or dz in (0,l-1)]

def build_plans(binding, before=None):
    """Index this goal's immutable intentions, not newly observed world cells."""
    if before is not None and (type(before) is not int or not 0<before<=2**63-1):raise ValueError('Invalid build history cursor')
    schema();key=scope(binding)
    rows=db.query('''SELECT a.rowid AS cursor,d.activity,d.task_id,d.request,d.disposition,t.data
        FROM minecraft_task_goals a INDEXED BY minecraft_goal_intents
        JOIN minecraft_dispatches d ON d.scope=a.scope AND d.activity=a.activity AND d.task_id=a.task_id
        JOIN minecraft_tasks t ON t.scope=d.scope AND t.activity=d.activity AND t.task_id=d.task_id
        WHERE a.scope=? AND a.goal_id=(SELECT goal_id FROM minecraft_goal_instances WHERE scope=?) AND a.rowid<=?
        ORDER BY a.rowid DESC LIMIT 129''',(key,key,before if before is not None else 2**63-1))
    plans=[];scanned=0;last=None
    for row in rows[:128]:
        scanned+=1;last=row['cursor']
        request=json.loads(row['request']);task=json.loads(row['data'])
        arguments=request.get('args');steps=arguments.get('steps') if isinstance(arguments,dict) else None
        candidates=[request] if request.get('skill')=='build' else steps[:24] if isinstance(steps,list) else []
        has_build=(request.get('skill')=='build' or request.get('skill')=='plan' and
                   (any(isinstance(part,dict) and part.get('skill')=='build' for part in candidates)
                    or isinstance(steps,dict) and steps.get('skill')=='build'))
        if not has_build:continue
        parts=[]
        for part in candidates:
            if isinstance(part,dict) and part.get('skill')=='build':
                parts.append(_planned_build_cells(part.get('args')))
        cells=[cell for part in parts if isinstance(part,list) for cell in part[:32]
               if isinstance(cell,dict) and all(type(cell.get(axis)) is int for axis in ('x','y','z'))]
        entry={'activityId':row['activity'],'taskId':row['task_id'],'state':task['state'],'dispatch':row['disposition'],
               'partCount':len(parts),'requestedCells':len(cells),
               'bounds':{'min':{axis:min(cell[axis] for cell in cells) for axis in ('x','y','z')},
                         'max':{axis:max(cell[axis] for cell in cells) for axis in ('x','y','z')}} if cells else None}
        if task.get('dimension'):entry['dimension']=task['dimension']
        plans.append(entry)
        if len(plans)==6:break
    return {'buildPlans':plans,'nextCursor':last-1 if last and last>1 and len(rows)>scanned else None}

def goal(binding):
    return goal_snapshot(binding)['goal']

def goal_snapshot(binding):
    """One read pairs a saved intention with its actual record time."""
    schema()
    rows=db.query('SELECT data,updated_at FROM minecraft_goals WHERE scope=?',(scope(binding),))
    return {'goal':json.loads(rows[0]['data']),'recordedAt':rows[0]['updated_at']} if rows else {'goal':None,'recordedAt':None}

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
    gains={};placed={};mined={};cleared={};positions=[];defeated=set();seen=set();pending=[(task.get('evidence',{}),0)];visited=0
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
                seen.add(identity);counts=mined if 'after' in row else cleared if block in {'minecraft:air','minecraft:cave_air','minecraft:void_air'} else placed
                counts[block]=counts.get(block,0)+1
                if counts is placed:positions.append({'block':block,**{axis:row[axis] for axis in ('x','y','z')}})
        if row.get('targetAlive') is False and type(row.get('entityId')) is int:defeated.add(row['entityId'])
        pending.extend((value,depth+1) for value in row.values() if isinstance(value,(list,dict)))
    if not (gains or placed or mined or cleared or defeated):return None
    result={'taskId':task['taskId'],'skill':task.get('skill','plan'),'partial':task['state']!='succeeded'}
    dimension=task.get('dimension')
    if isinstance(dimension,str) and len(dimension)<=128 and re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]+',dimension):result['dimension']=dimension
    if gains:result['gains']=[{'item':item,'count':count} for item,count in sorted(gains.items())]
    if placed:result['placed']=[{'block':block,'count':count} for block,count in sorted(placed.items())]
    if mined:result['mined']=[{'block':block,'count':count} for block,count in sorted(mined.items())]
    if cleared:result['cleared']=[{'block':block,'count':count} for block,count in sorted(cleared.items())]
    if positions:result['positions']=positions[-4:]
    if defeated:result['defeated']=len(defeated)
    return result

def progress(binding, limit=8):
    schema();key=scope(binding)
    # The stored index selects milestones. Rebuild the bounded projection from
    # immutable receipts so older indexes cannot keep reporting placed air.
    rows=db.query('SELECT r.data FROM minecraft_task_goals t JOIN minecraft_goal_instances g ON g.scope=t.scope AND g.goal_id=t.goal_id JOIN minecraft_tasks r ON r.scope=t.scope AND r.activity=t.activity AND r.task_id=t.task_id WHERE t.scope=? AND t.progress IS NOT NULL ORDER BY t.updated_at DESC,t.rowid DESC LIMIT ?',(key,min(8,max(1,limit))))
    return [value for row in reversed(rows) if (value:=_progress(json.loads(row['data']))) is not None]

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
    for task in changed:
        facts=list(_receipt_facts(task,db.now_iso()))
        for offset in range(0,len(facts),128):apply_block_facts(binding,facts[offset:offset+128])
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
    samples=[(block,96*96) for block in observation.get('visibleLandmarks',[])[:6]]+[(block,64) for block in observation.get('visibleBlocks',[])[:8]]
    seen=set();observed_positions=set()
    for block,distance_limit in samples:
        if not isinstance(block,dict):continue
        name=block.get('block','')
        coords=[block.get(k) for k in ('x','y','z')]
        if not isinstance(name,str) or len(name)>128 or not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]+',name):continue
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in coords):continue
        if sum((v-p)**2 for v,p in zip(coords,xyz))>distance_limit:continue
        observed_positions.add(tuple(coords))
        if name in {'minecraft:grass_block','minecraft:dirt','minecraft:stone','minecraft:short_grass'}:continue
        identity=(name,*coords)
        if identity in seen:continue
        seen.add(identity);landmarks.append({'block':name,**dict(zip(('x','y','z'),coords))})
    captured=observation.get('observedAt')
    seen_at=(datetime.fromtimestamp(captured/1000,timezone.utc).isoformat()
             if type(captured) is int and 0<captured<=time.time()*1000+60_000 else db.now_iso())
    place={'dimension':dimension,'x':round(x,1),'y':round(y,1),'z':round(z,1),'landmarks':landmarks,'observedAt':seen_at}
    schema();key=scope(binding)
    with db.tx() as c:
        previous=c.execute('SELECT data,updated_at FROM minecraft_places WHERE scope=? AND dimension=? AND chunk_x=? AND chunk_z=?',
                           (key,dimension,math.floor(x/16),math.floor(z/16))).fetchone()
        known=[{**block,'seenAt':seen_at} for block in landmarks]
        if previous:
            old=json.loads(previous['data'])
            for block in old.get('knownLandmarks',old.get('landmarks',[]))[:32]:
                value=_stored_marker(block,previous['updated_at'])
                if value and tuple(value[k] for k in ('x','y','z')) not in observed_positions:
                    known.append(value)
        unique={}
        for block in known:
            unique.setdefault(tuple(block[k] for k in ('x','y','z')),block)
        place['knownLandmarks']=list(unique.values())[:32]
        c.execute('INSERT INTO minecraft_places VALUES(?,?,?,?,?,?) ON CONFLICT(scope,dimension,chunk_x,chunk_z) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
                  (key,dimension,math.floor(x/16),math.floor(z/16),json.dumps(place),db.now_iso()))
        c.execute('DELETE FROM minecraft_places WHERE scope=? AND rowid NOT IN (SELECT rowid FROM minecraft_places WHERE scope=? ORDER BY updated_at DESC LIMIT 1024)',(key,key))

def explored(binding,limit=8):
    schema()
    return [{k:v for k,v in json.loads(row['data']).items() if k!='knownLandmarks'}
            for row in db.query('SELECT data FROM minecraft_places WHERE scope=? ORDER BY updated_at DESC LIMIT ?',
                                (scope(binding),min(32,max(1,limit))))]


def _stored_marker(block,at):
    if not isinstance(block,dict):return None
    name=block.get('block','');coords=[block.get(k) for k in ('x','y','z')]
    if not isinstance(name,str) or len(name)>128 or not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]+',name):return None
    if any(type(v) not in (int,float) or not math.isfinite(v) or abs(v)>30_000_000 for v in coords):return None
    seen=block.get('seenAt',at)
    if not isinstance(seen,str) or len(seen)>64:seen=at
    return {'block':name,**dict(zip(('x','y','z'),coords)),'seenAt':seen}


def _millis(value):
    try:
        stamp=datetime.fromisoformat(value)
        return stamp.timestamp()*1000 if stamp.tzinfo is not None else None
    except (ValueError,TypeError,OverflowError):return None


def _block_fact(value):
    if not isinstance(value,dict):return None
    seq=value.get('seq');server=value.get('serverBlockSeq');at=value.get('observedAt')
    if type(seq) is not int or not 0<seq<2**63:return None
    if type(at) is not int or not 0<at<=time.time()*1000+60000:return None
    source=value.get('source');block=value.get('block');dimension=value.get('dimension')
    if source=='mined':
        if type(server) is not int or server<=0:return None
    elif source=='visible_absence':
        if type(server) is not int or server!=0 or block!='minecraft:air':return None
    else:return None
    if not isinstance(block,str) or not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]{1,100}',block):return None
    if not isinstance(dimension,str) or not re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]{1,100}',dimension):return None
    coords=[value.get(k) for k in ('x','y','z')]
    if any(type(v) is not int for v in coords) or not -64<=coords[1]<=319 or any(abs(coords[i])>30_000_000 for i in (0,2)):return None
    return {**value,'identity':(dimension,*coords)}


def _invalidates(marker,fact):
    at=_millis(marker.get('seenAt'))
    return at is not None and at<fact['observedAt'] and marker['block']!=fact['block']


def apply_block_facts(binding,facts,*,after=0):
    """Update place projections from observed effects, never from task intent.

    Keep visit order/timestamps and raw task history. Older delayed facts cannot
    erase a later observation (including a tree that has actually regrown).
    """
    if not isinstance(facts,list) or len(facts)>128:return after
    valid=[fact for row in facts if (fact:=_block_fact(row)) is not None and fact['seq']>after
           and ('account' not in fact or fact['account']==binding.get('account'))]
    if not valid:return after
    newest={}
    for fact in valid:
        old=newest.get(fact['identity'])
        if old is None or fact['observedAt']>old['observedAt']:newest[fact['identity']]=fact
    schema();key=scope(binding)
    with db.tx() as c:
        for row in c.execute('SELECT rowid,data,updated_at FROM minecraft_places WHERE scope=?',(key,)).fetchall():
            place=json.loads(row['data']);changed=False
            for field in ('landmarks','knownLandmarks'):
                if field not in place:continue
                kept=[]
                for block in place[field]:
                    marker=_stored_marker(block,place.get('observedAt',row['updated_at']))
                    fact=newest.get((place.get('dimension'),*(marker[k] for k in ('x','y','z')))) if marker else None
                    if marker and fact and _invalidates(marker,fact):changed=True
                    else:kept.append(block)
                place[field]=kept
            if changed:c.execute('UPDATE minecraft_places SET data=? WHERE rowid=?',(json.dumps(place),row['rowid']))
    return max(fact['seq'] for fact in valid)


def _state_name(value):
    if not isinstance(value,str) or len(value)>512:return None
    if re.fullmatch(r'[a-z0-9_.-]+:[a-z0-9_./-]+',value):return value
    match=re.fullmatch(r'Block\{([a-z0-9_.-]+:[a-z0-9_./-]+)\}(?:\[[^\n]*\])?',value)
    return match[1] if match else None


def _receipt_facts(task,recorded_at):
    """Read only actual server confirmations, including completed plan steps."""
    if task.get('state') not in {'succeeded','failed','cancelled'}:return
    dimension=task.get('dimension');fallback=_millis(recorded_at)
    def walk(value,depth=0):
        if depth>6:return
        if isinstance(value,dict):
            server=value.get('serverBlockSeq');before=_state_name(value.get('block'));block=_state_name(value.get('after'))
            if type(server) is int and server>0 and before and block and before!=block:
                raw={'seq':server,'source':'mined','serverBlockSeq':server,'dimension':dimension,'block':block,
                     'observedAt':value.get('serverObservedAt',int(fallback) if fallback is not None else 0),
                     **{k:value.get(k) for k in ('x','y','z')}}
                if _block_fact(raw) is not None:yield raw
            for key in ('evidence','steps','result','changes'):
                if key in value:yield from walk(value[key],depth+1)
        elif isinstance(value,list):
            for child in value[:96]:yield from walk(child,depth+1)
    yield from walk(task)


def recall_places(binding,query=''):
    """Bounded historical sightings from this world/account, never a world read."""
    if not isinstance(query,str) or len(query)>64:raise ValueError('Invalid place query')
    schema()
    rows=db.query('SELECT data,updated_at FROM minecraft_places WHERE scope=? ORDER BY updated_at DESC LIMIT 1024',(scope(binding),))
    origin=json.loads(rows[0]['data']) if rows else {}
    points={}
    for row in rows:
        place=json.loads(row['data']);dimension=place.get('dimension')
        if not isinstance(dimension,str):continue
        for block in place.get('knownLandmarks',place.get('landmarks',[]))[:32]:
            marker=_stored_marker(block,row['updated_at'])
            if not marker or query.strip().lower() not in marker['block']:continue
            identity=(dimension,*(marker[k] for k in ('x','y','z')))
            marker={**marker,'dimension':dimension}
            if identity not in points or marker['seenAt']>points[identity]['seenAt']:points[identity]=marker
    # Legacy journals already hold authoritative mine receipts. Stream them
    # locally since the oldest candidate sighting; no world query or replay.
    dates=[at for point in points.values() if (at:=_millis(point['seenAt'])) is not None]
    if dates:
        since=datetime.fromtimestamp(min(dates)/1000,timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
        with db.tx() as c:
            for row in c.execute('SELECT data,updated_at FROM minecraft_tasks WHERE scope=? AND updated_at>=?',(scope(binding),since)):
                for raw in _receipt_facts(json.loads(row['data']),row['updated_at']):
                    fact=_block_fact(raw);identity=fact['identity'];point=points.get(identity)
                    if point and _invalidates(point,fact):points.pop(identity)
    def distance(point):
        return sum((point[k]-origin.get(k,0))**2 for k in ('x','y','z'))
    result=[];areas=set()
    for point in sorted(points.values(),key=lambda p:(p['dimension']!=origin.get('dimension'),distance(p))):
        area=(point['dimension'],math.floor(point['x']/16),math.floor(point['z']/16))
        if area in areas:continue
        areas.add(area);result.append(point)
        if len(result)==6:break
    return result
