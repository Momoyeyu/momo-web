import pytest
from app.services.app_permissions import AppPermissions,AppApprovalRequired
TARGET={'bundleId':'test.app','appPath':'/Applications/Test.app','name':'Test'}
def request(p,key='a',caps=('observe',)):
 with pytest.raises(AppApprovalRequired) as e:p.require(TARGET,1,key,caps)
 return e.value.request_id

def test_once_and_revoke(tmp_path):
 p=AppPermissions(tmp_path/'permissions.json');rid=request(p)
 assert request(p)==rid
 p.decide(rid,'once',1)
 grant=p.require(TARGET,1,'a',['observe']);assert p.check(grant,TARGET,1)
 assert not p.saved()
 p.revoke_epoch(1)
 with pytest.raises(ValueError):p.check(grant,TARGET,1)

def test_always_subset_and_revoke(tmp_path):
 p=AppPermissions(tmp_path/'permissions.json');rid=request(p,caps=['observe','interact'])
 p.decide(rid,'always',1,['observe'])
 grant=p.require(TARGET,1,'b',['observe']);assert p.check(grant,TARGET,1)
 request(p,'c',['interact'])
 p.remove(grant['appId'])
 with pytest.raises(ValueError):p.check(grant,TARGET,1)
 assert not p.saved()

def test_denied_no_reprompt_expiry_and_duplicate(tmp_path):
 now=[0];p=AppPermissions(tmp_path/'permissions.json',lambda:now[0]);rid=request(p)
 p.decide(rid,'deny',1)
 assert request(p)==rid
 assert p.status()['pending']==[]
 with pytest.raises(ValueError):p.decide(rid,'always',1)
 request(p,'other');now[0]=301
 assert not p.status()['pending']

def test_stop_consumes_once_and_revoke_callback(tmp_path):
 p=AppPermissions(tmp_path/'permissions.json');rid=request(p)
 p.decide(rid,'once',1);grant=p.require(TARGET,1,'a',['observe'])
 p.revoke_grant(grant)
 with pytest.raises(AppApprovalRequired) as e:p.require(TARGET,1,'a',['observe'])
 assert e.value.status=='denied'
 called=[];p.on_revoke=called.append;p.remove(grant['appId'])
 assert called==[grant['appId']]


def test_grant_gets_five_minutes_from_approval_but_cannot_renew_itself(tmp_path):
 now=[0];p=AppPermissions(tmp_path/'permissions.json',lambda:now[0]);rid=request(p)
 now[0]=299;p.decide(rid,'once',1)
 grant=p.require(TARGET,1,'a',['observe'])
 now[0]=301;assert p.check(grant,TARGET,1)
 now[0]=599
 with pytest.raises(ValueError):p.check(grant,TARGET,1)
 with pytest.raises(AppApprovalRequired) as error:p.require(TARGET,1,'a',['observe'])
 assert error.value.status=='expired'


def test_pending_request_still_expires_before_approval(tmp_path):
 now=[0];p=AppPermissions(tmp_path/'permissions.json',lambda:now[0]);rid=request(p)
 now[0]=300
 with pytest.raises(ValueError):p.decide(rid,'once',1)
 assert not p.grants
