"""Application approvals: server-resolved identities, revocable grants, no replay."""
import hashlib,json,os,secrets,threading,time,stat,copy
from pathlib import Path
from ..core import state

class AppApprovalRequired(ValueError):
 def __init__(self,request_id,status):
  self.request_id=request_id;self.status=status
  super().__init__('Application approval '+status)

class AppPermissions:
 def __init__(self,path=None,clock=time.monotonic):
  self.path=path;self.clock=clock;self.lock=threading.RLock();self.requests={};self.grants={};self.versions={};self.revoked=set();self.on_revoke=None
 def file(self):return Path(self.path) if self.path else state.DATA_DIR/'app-permissions.json'
 def identity(self,target):
  path=Path(target['appPath'])
  if not path.is_absolute() or str(path.resolve())!=str(path) or not target.get('bundleId'):raise ValueError('Verified application identity required')
  return hashlib.sha256((target['bundleId']+'\0'+str(path)).encode()).hexdigest()
 def saved(self):
  p=self.file()
  if not p.exists():return {}
  fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
  with os.fdopen(fd) as stream:
   info=os.fstat(stream.fileno())
   if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_size>1048576:raise ValueError('Invalid permission store')
   data=json.load(stream)
  return data if isinstance(data,dict) else {}
 def write(self,data):
  p=self.file();p.parent.mkdir(parents=True,exist_ok=True)
  temp=p.with_name(p.name+'.'+secrets.token_hex(8));fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  with os.fdopen(fd,'w') as stream:json.dump(data,stream)
  os.replace(temp,p)
 def public(self,r):return {k:v for k,v in r.items() if k not in ('key','expires')}
 def status(self):
  with self.lock:
   return {'pending':[self.public(r) for r in self.requests.values() if r['status']=='pending' and r['epoch'] not in self.revoked and r['expires']>self.clock()], 'allowlist':list(self.saved().values())}
 def require(self,target,activity_epoch,request_key,capabilities):
  with self.lock:
   app=self.identity(target)
   capabilities=sorted(set(capabilities))
   if not capabilities or not set(capabilities)<= {"observe","interact"}:raise ValueError("Invalid capabilities")
   if activity_epoch in self.revoked:raise ValueError('Activity revoked')
   key=(app,activity_epoch,request_key,tuple(capabilities))
   previous=next((r for r in self.requests.values() if r['key']==key),None)
   if previous:
    if previous['status']=='denied':raise AppApprovalRequired(previous['id'],'denied')
    if previous['expires']<=self.clock():raise AppApprovalRequired(previous['id'],'expired')
    if previous['status']=='granted':return copy.deepcopy(self.grants[previous['id']])
    raise AppApprovalRequired(previous['id'],'pending')
   rid=secrets.token_urlsafe(24)
   r={'id':rid,'appId':app,'appName':target.get('name',target.get('appName',target['bundleId'])),'bundleId':target['bundleId'],'appPath':target['appPath'],'epoch':activity_epoch,'reason':target.get('reason',''),'target':{k:target[k] for k in ('bundleId','appPath')},'capabilities':capabilities,'status':'pending','key':key,'expires':self.clock()+300}
   self.requests[rid]=r
   saved=self.saved().get(app,{})
   if set(capabilities)<=set(saved.get('capabilities',[])):return self._grant(r,'always')
   raise AppApprovalRequired(rid,'pending')
 def _grant(self,r,decision):
  r['status']='granted'
  g={'id':r['id'],'appId':r['appId'],'epoch':r['epoch'],'version':self.versions.get(r['appId'],0),'expires':r['expires'],'decision':decision,'capabilities':list(r['capabilities'])}
  self.grants[r['id']]=g
  return copy.deepcopy(g)
 def decide(self,rid,decision,epoch,capabilities=None):
  with self.lock:
   r=self.requests.get(rid)
   if not r or r['status']!='pending' or r['epoch']!=epoch or epoch in self.revoked or r['expires']<=self.clock():raise ValueError('Approval request expired or already decided')
   if capabilities is not None:
    if not set(capabilities)<=set(r['capabilities']) or not capabilities:raise ValueError('Invalid granted subset')
    r['capabilities']=sorted(set(capabilities))
   if decision=='deny':r['status']='denied'
   elif decision in ('once','always'):
    if decision=='always':
     data=self.saved();existing=data.get(r['appId'],{}).get('capabilities',[])
     data[r['appId']]={k:r[k] for k in ('appId','appName','bundleId','appPath','capabilities')}
     data[r['appId']]['capabilities']=sorted(set(existing)|set(r['capabilities']));self.write(data)
    self._grant(r,decision)
   else:raise ValueError('Invalid decision')
   return self.public(r)
 def check(self,grant,target,epoch):
  with self.lock:
   app=self.identity(target)
   current=self.grants.get(grant.get('id'))
   if not current or current!=grant or epoch in self.revoked or grant['epoch']!=epoch or grant['appId']!=app or grant['version']!=self.versions.get(app,0) or grant['expires']<=self.clock():raise ValueError('Application permission revoked')
   return True
 def remove(self,app):
  with self.lock:
   data=self.saved();data.pop(app,None);self.write(data);self.versions[app]=self.versions.get(app,0)+1
   for r in self.requests.values():
    if r['appId']==app:r['status']='denied'
  if self.on_revoke:self.on_revoke(app)
  return {'revoked':True}
 def revoke_grant(self,grant):
  with self.lock:
   rid=grant.get('id');self.grants.pop(rid,None)
   if rid in self.requests:self.requests[rid]['status']='denied'
 def revoke_request(self,rid):
  with self.lock:
   self.grants.pop(rid,None)
   if rid in self.requests:self.requests[rid]['status']='denied'
 def revoke_epoch(self,epoch):
  with self.lock:self.revoked.add(epoch)
permissions=AppPermissions()
