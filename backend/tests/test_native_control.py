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
 p=AppPermissions(tmp_path/'permissions.json');monkeypatch.setattr(module,'permissions',p)
 c=module.NativeControl();monkeypatch.setattr(c,'gate',lambda *a,**kw:None)
 from app.services.computer import computer
 monkeypatch.setattr(computer,'start',lambda *a:None)
 monkeypatch.setattr(computer,'stop',lambda *a:None)
 return c,p,calls

def test_start_requires_global_consent_and_enforces_blocklist(setup):
 c,p,calls=setup
 with pytest.raises(ValueError):c.start(1,12,['observe','interact'],'owner','lease')
 assert calls==[]
 p.consent(True)
 p.block('test.app','Test',True)
 assert c.available_targets()['targets']==[]
 with pytest.raises(ValueError):c.start(1,12,['observe','interact'],'owner','lease')
 assert all(method!='native.start' for method,_ in calls)
 p.block('test.app','Test',False)
 assert c.start(1,12,['observe','interact'],'owner','lease')['active']
 assert calls[-1][1]['permissions']==['observe','interact']

def test_replacement_cannot_mutate_live_plugin(setup):
 c,p,calls=setup
 p.consent(True);c.start(1,12,['observe'],'owner','lease')
 with pytest.raises(ValueError):c.start(1,12,['observe'],'owner','lease','browser')
 assert c.plugin=='computer'
 p.block('test.app','Test',True)
 with pytest.raises(ValueError):c.execute({'action':'observe'})

def test_model_change_blocks_existing_grant(setup,monkeypatch):
 c,p,calls=setup
 p.consent(True);c.start(1,12,['observe'],'owner','lease')
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

def test_frame_does_not_require_or_modify_application_grants(setup,monkeypatch):
 from app.services.computer import computer
 c,p,calls=setup
 monkeypatch.setattr(computer,'desktop_frame',lambda:{'observationAvailable':True})
 monkeypatch.setattr(module.runtime,'require_meeting',lambda *_:None,raising=False)
 result=c.frame('owner','lease')
 assert result['observationAvailable'] and c.target is None and not calls

def test_start_preserves_configured_reaction_preferences(setup,monkeypatch):
 from app.services.computer import computer
 c,p,calls=setup;starts=[]
 monkeypatch.setattr(computer,'proactive',True);monkeypatch.setattr(computer,'reactions',True)
 monkeypatch.setattr(computer,'start',lambda *args:starts.append(args))
 p.consent(True);c.start(1,12,['observe'],'owner','lease')
 assert starts==[]  # Application control must not replace the desktop view.
 assert computer.proactive and computer.reactions

def test_stop_does_not_wait_for_blocked_action_and_rejects_late_result(setup):
 import time
 c,p,calls=setup
 p.consent(True);c.start(1,12,['observe'],'owner','lease')
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


def test_observation_pixels_map_to_logical_window_coordinates(setup):
 c,p,calls=setup
 p.consent(True);c.start(1,12,['observe','interact'],'owner','lease')
 original=module.runtime.host.request
 def host(method,params=None):
  if method=='native.observe':return {'version':7,'bounds':{'x':100,'y':200,'width':800,'height':600}}
  return original(method,params)
 module.runtime.host.request=host
 c.execute({'action':'observe'})
 info=c.bind_observation(c.generation,7,{'width':1024,'height':768})
 assert info=={'imageWidth':1024,'imageHeight':768,'coordinateSpace':'image-pixels'}
 command={'action':'click','x':512,'y':384}
 c.execute(command,7)
 assert calls[-1][1]['command']=={'action':'click','x':400,'y':300}
 assert command['x']==512


@pytest.mark.parametrize('x,y,version', [(-1,0,7),(1024,0,7),(0,768,7),(float('nan'),0,7),(True,0,7),(1,1,6)])
def test_observation_mapping_rejects_outside_or_stale_coordinates(setup,x,y,version):
 c,p,calls=setup
 p.consent(True);c.start(1,12,['observe','interact'],'owner','lease')
 original=module.runtime.host.request
 module.runtime.host.request=lambda method,params=None: {'version':7,'bounds':{'width':800,'height':600}} if method=='native.observe' else original(method,params)
 c.execute({'action':'observe'});c.bind_observation(c.generation,7,{'width':1024,'height':768})
 before=len(calls)
 with pytest.raises(ValueError):c.execute({'action':'scroll','x':x,'y':y,'delta':10},version)
 assert len(calls)==before


def test_observation_mapping_expires_without_refreshing_input_authority(setup):
 c,p,calls=setup
 p.consent(True);c.start(1,12,['observe','interact'],'owner','lease')
 original=module.runtime.host.request
 module.runtime.host.request=lambda method,params=None: {'version':7,'bounds':{'width':800,'height':600}} if method=='native.observe' else original(method,params)
 c.execute({'action':'observe'});c.bind_observation(c.generation,7,{'width':512,'height':384})
 c.projection['observed']-=16
 before=len(calls)
 with pytest.raises(ValueError):c.execute({'action':'click','x':100,'y':100},7)
 assert len(calls)==before

def test_same_window_request_reuses_checked_grant_without_restart(setup):
 c,p,calls=setup
 p.consent(True)
 c.start(1,12,['observe','interact'],'owner','lease')
 starts=sum(method=='native.start' for method,_ in calls)
 result=c.start(1,12,['observe','interact'],None,None)
 assert result['active'] and result['permissions']==['interact','observe']
 assert sum(method=='native.start' for method,_ in calls)==starts
 p.consent(False)
 with pytest.raises(ValueError):c.start(1,12,['observe'],None,None)

def test_same_window_request_cannot_expand_scope(setup):
 c,p,calls=setup
 p.consent(True);c.start(1,12,['observe'],'owner','lease')
 with pytest.raises(ValueError):c.start(1,12,['observe','interact'],None,None)
