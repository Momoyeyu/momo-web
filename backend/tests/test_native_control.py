import threading
from types import SimpleNamespace
import pytest
from app.services import native_control as module,app_permissions
from app.services.app_permissions import AppPermissions
TARGET={'windowId':1,'ownerPid':12,'path':'/Applications/Test.app','bundleId':'test.app','name':'Test'}
@pytest.fixture
def setup(tmp_path,monkeypatch):
 calls=[]
 host=SimpleNamespace(control=threading.RLock(),request=lambda method,params=None:(calls.append((method,params)) or ({'targets':[TARGET]} if method=='native.targets' else {'ok':True,'bindingId':'fixture-binding'})),permit=lambda _: {})
 monkeypatch.setattr(module,'runtime',SimpleNamespace(host=host,epoch=1))
 monkeypatch.setattr(module.state,'load',lambda:{'settings':{'llm':{}}})
 monkeypatch.setattr(module.vision,'fingerprint',lambda _: 'fixed')
 p=AppPermissions(tmp_path/'permissions.json');monkeypatch.setattr(app_permissions,'permissions',p)
 c=module.NativeControl();monkeypatch.setattr(c,'gate',lambda *a,**kw:None)
 from app.services.computer import computer
 monkeypatch.setattr(computer,'start',lambda *a:None)
 monkeypatch.setattr(computer,'stop',lambda *a:None)
 return c,p,calls

def test_no_action_before_approval_and_subset(setup):
 c,p,calls=setup
 r=c.start(1,12,['observe','interact'],'owner','lease')
 assert r['approvalRequired'] and all(m!='native.start' for m,_ in calls)
 with pytest.raises(ValueError):c.execute({'action':'observe'})
 p.decide(r['requestId'],'once',1,['observe'])
 c.start(1,12,['observe','interact'],'owner','lease')
 assert calls[-1][1]['permissions']==['observe']
 with pytest.raises(ValueError):c.execute({'action':'click'})
 assert c.execute({'action':'observe'})['ok']

def test_stop_cancels_pending_and_consumes_grant(setup):
 c,p,calls=setup
 r=c.start(1,12,['observe'],'owner','lease');c.stop()
 with pytest.raises(ValueError):p.decide(r['requestId'],'once',1)
 r=c.start(1,12,['observe'],'owner','lease');p.decide(r['requestId'],'once',1)
 c.start(1,12,['observe'],'owner','lease');old=c.grant.copy();c.stop()
 with pytest.raises(ValueError):p.check(old,{**TARGET,'appPath':TARGET['path']},1)
 assert calls[-1][0]=='native.stop'

def test_replacement_cannot_mutate_live_plugin(setup):
 c,p,calls=setup
 r=c.start(1,12,['observe'],'owner','lease');p.decide(r['requestId'],'always',1)
 c.start(1,12,['observe'],'owner','lease')
 with pytest.raises(ValueError):c.start(1,12,['observe'],'owner','lease','browser')
 assert c.plugin=='computer'
 p.remove(c.grant['appId'])
 with pytest.raises(ValueError):c.execute({'action':'observe'})

def test_model_change_blocks_existing_grant(setup,monkeypatch):
 c,p,calls=setup
 r=c.start(1,12,['observe'],'owner','lease');p.decide(r['requestId'],'once',1);c.start(1,12,['observe'],'owner','lease')
 monkeypatch.setattr(module.vision,'fingerprint',lambda _: 'changed')
 with pytest.raises(ValueError):c.execute({'action':'observe'})

def test_failed_stop_blocks_restart_until_retry(setup):
 c,p,calls=setup
 original=module.runtime.host.request
 def failed(method,params=None):
  if method=='native.stop':raise ValueError('executor lost')
  return original(method,params)
 module.runtime.host.request=failed
 c.target=TARGET
 with pytest.raises(ValueError):c.stop()
 assert c.status()['stopUnconfirmed']
 with pytest.raises(ValueError):c.start(1,12,['observe'],'owner','lease')
 module.runtime.host.request=original
 c.stop();assert not c.status()['stopUnconfirmed']

def test_frame_stages_pixels_without_exposing_them(setup,monkeypatch):
 import base64
 from app.services.computer import computer
 c,p,calls=setup
 r=c.start(1,12,['observe'],'owner','lease');p.decide(r['requestId'],'once',1);c.start(1,12,['observe'],'owner','lease')
 original=module.runtime.host.request
 module.runtime.host.request=lambda method,params=None: {'data':base64.b64encode(b'pixels').decode()} if method=='native.observe' else original(method,params)
 captured=[]
 monkeypatch.setattr(computer,'capture',lambda raw,generation:captured.append(raw) or {'changed':True,'generation':generation})
 result=c.frame('owner','lease');assert captured==[b'pixels'] and 'data' not in result
 p.remove(c.grant['appId'])
 with pytest.raises(ValueError):c.frame('owner','lease')
 assert len(captured)==1

def test_start_preserves_configured_reaction_preferences(setup,monkeypatch):
 from app.services.computer import computer
 c,p,calls=setup;starts=[]
 monkeypatch.setattr(computer,'proactive',True);monkeypatch.setattr(computer,'reactions',True)
 monkeypatch.setattr(computer,'start',lambda *args:starts.append(args))
 r=c.start(1,12,['observe'],'owner','lease');p.decide(r['requestId'],'once',1);c.start(1,12,['observe'],'owner','lease')
 assert starts==[('Test',True,True)]

def test_stop_does_not_wait_for_blocked_action_and_rejects_late_result(setup):
 import time
 c,p,calls=setup
 r=c.start(1,12,['observe'],'owner','lease');p.decide(r['requestId'],'once',1);c.start(1,12,['observe'],'owner','lease')
 entered=threading.Event();release=threading.Event();errors=[];original=module.runtime.host.request
 def blocked(method,params=None):
  if method=='native.observe':
   assert params['bindingId']=='fixture-binding'
   entered.set();release.wait(2);return {'ok':True}
  return original(method,params)
 module.runtime.host.request=blocked
 def work():
  try:c.execute({'action':'observe'})
  except ValueError as error:errors.append(str(error))
 thread=threading.Thread(target=work);thread.start();assert entered.wait(1)
 start=time.monotonic();c.stop();assert time.monotonic()-start<.2
 assert not c.status()['active'];release.set();thread.join(1)
 assert errors


def test_resume_uses_pending_target_and_waits_for_model(setup):
 c,p,calls=setup
 module.runtime.require_meeting=lambda *args:None
 module.runtime.active=True
 r=c.start(1,12,['observe'],'owner','lease')
 with pytest.raises(ValueError):c.resume(r['requestId'],'owner','lease')
 p.decide(r['requestId'],'once',1)
 assert c.resume(r['requestId'],'owner','lease')=={'waiting':True}
 with pytest.raises(ValueError):c.resume('other-request','owner','lease')
 module.runtime.active=False
 assert c.resume(r['requestId'],'owner','lease')['active']
 with pytest.raises(ValueError):c.resume(r['requestId'],'owner','lease')

def test_expired_request_can_be_explicitly_retried(setup):
 c,p,calls=setup
 r=c.start(1,12,['observe'],'owner','lease')
 p.requests[r['requestId']]['expires']=0
 assert c.start(1,12,['observe'],'owner','lease')['status']=='expired'
 retry=c.start(1,12,['observe'],'owner','lease')
 assert retry['status']=='pending' and retry['requestId']!=r['requestId']
