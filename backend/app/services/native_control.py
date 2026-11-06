"""Existing-application control; one coordinator, explicit application grants."""
import threading
import uuid
from .coordinator import runtime
from . import vision, activities
from ..core import state

class NativeControl:
    def __init__(self):
        self.lock=threading.RLock()
        self.target=None
        self.grant=None
        self.pending=None
        self.pending_request=None
        self.generation=0
        self.plugin='computer'
        self.stop_unconfirmed=False
        self.stopping=False
        self.session_id=None

    def gate(self,client=None,lease=None,allow_busy=False):
        if client is None:
            from .computer_tools import require_local
            require_local()
        else: runtime.require_meeting(client,lease)
        activities.require_enabled(self.plugin)
        if not runtime.started or runtime.mode!='meeting' or runtime.focus or runtime.restoring:
            raise ValueError('Application attention unavailable')
        # The authenticated frame path may keep observing during a local response.
        if client is not None and not allow_busy and (runtime.active or runtime.interrupt_hold): raise ValueError('Wait for the current response to finish')
        vision.require_enabled(state.load()['settings']['llm'])
        if not runtime.host: raise ValueError('Application executor unavailable')

    def targets(self,client,lease,plugin='computer'):
        if plugin not in ('computer','browser'): raise ValueError('Invalid plugin')
        runtime.require_meeting(client,lease)
        activities.require_enabled(plugin)
        if not runtime.host: raise ValueError('Application executor unavailable')
        return runtime.host.request('native.targets')

    def status(self):
        return {'active':self.target is not None,'target':self.target,'generation':self.generation,'plugin':self.plugin,'stopUnconfirmed':self.stop_unconfirmed,'stopping':self.stopping}

    def start(self,window,pid,capabilities,client,lease,plugin='computer',proactive=None,reactions=None,expected_request=None):
        from .app_permissions import permissions, AppApprovalRequired
        if plugin not in ('computer','browser') or not set(capabilities)<= {'observe','interact'} or 'observe' not in capabilities:
            raise ValueError('Invalid application scope')
        if not runtime.host: raise ValueError('Application executor unavailable')
        with runtime.host.control, self.lock:
            if expected_request is not None and (self.pending_request != expected_request or not self.pending or self.pending[0][3] != runtime.epoch):
                raise ValueError('Approval request no longer current')
            if self.target or self.stop_unconfirmed or self.stopping: raise ValueError('Stop the current application activity first')
            from .computer import computer
            from .minecraft import minecraft
            if computer.observing or minecraft.binding:raise ValueError('Another activity owns attention')
            self.plugin=plugin
            self.gate(client,lease)
            result=runtime.host.request('native.targets')
            rows=result.get('targets',[]) if isinstance(result,dict) else result
            target=next((r for r in rows if r.get('windowId')==window and r.get('ownerPid')==pid),None)
            if target is None: raise ValueError('Target window no longer exists')
            target={**target,'appPath':target['path']}
            signature=(window,pid,tuple(sorted(capabilities)),runtime.epoch,plugin)
            if not self.pending or self.pending[0]!=signature:
                self.pending=(signature,str(uuid.uuid4()))
            try: grant=permissions.require(target,runtime.epoch,self.pending[1],capabilities)
            except AppApprovalRequired as error:
                self.pending_request=error.request_id
                if error.status == 'expired':
                    self.pending = None
                    self.pending_request = None
                return {'approvalRequired':True,'requestId':error.request_id,'status':error.status}
            with runtime.host.control:
                self.gate(client,lease)
                permissions.check(grant,target,runtime.epoch)
                if 'observe' not in grant['capabilities']:raise ValueError('Observation approval required')
                started=runtime.host.request('native.start',{'windowId':window,'ownerPid':pid,'permissions':grant['capabilities'],'permit':runtime.host.permit('native-start')})
                if plugin=='computer':
                    from .computer import computer
                    try: computer.start(target.get('name',target['bundleId']),computer.proactive if proactive is None else proactive,computer.reactions if reactions is None else reactions)
                    except Exception:
                        runtime.host.request('native.stop')
                        permissions.revoke_grant(grant)
                        raise
                self.session_id=started['bindingId']
                self.target,self.grant=target,grant
                self.epoch=runtime.epoch
                self.fingerprint=vision.fingerprint(state.load()['settings']['llm'])
                self.generation+=1
                self.pending=None
                self.pending_request=None
            return self.status()

    def resume(self, request_id, client, lease):
        """Resume only the server-held request; the UI cannot substitute a target."""
        runtime.require_meeting(client, lease)
        with self.lock:
            if not self.pending or self.pending_request != request_id:
                raise ValueError('Approval request no longer current')
            window, pid, capabilities, epoch, plugin = self.pending[0]
            if epoch != runtime.epoch:
                raise ValueError('Activity changed')
            self.gate(client, lease, allow_busy=True)
            from .app_permissions import permissions
            with permissions.lock:
                grant = permissions.grants.get(request_id)
                if not grant or grant['epoch'] != epoch or grant['expires'] <= permissions.clock():
                    raise ValueError('Application approval required')
            if runtime.active:
                return {'waiting': True}
        return self.start(window, pid, capabilities, client, lease, plugin, expected_request=request_id)

    def validate(self,generation,client=None,lease=None):
        from .app_permissions import permissions
        self.gate(client,lease,allow_busy=True)
        if not self.target or generation!=self.generation or self.epoch!=runtime.epoch or self.fingerprint!=vision.fingerprint(state.load()['settings']['llm']):
            raise ValueError('Application grant changed')
        permissions.check(self.grant,self.target,runtime.epoch)

    def execute(self,command,version=None):
        host=runtime.host
        if not host:raise ValueError('Application executor unavailable')
        with self.lock:
            generation=self.generation
            self.validate(generation)
            method='native.observe' if command['action']=='observe' else 'native.action'
            if command['action'] != 'observe' and 'interact' not in self.grant['capabilities']:
                raise ValueError('Interaction not granted')
            params={'command':command,'version':version,'bindingId':self.session_id,'permit':host.permit('native-action')}
        result=host.request(method,params)
        with self.lock:
            self.validate(generation)
            return result

    def frame(self,client,lease):
        import base64
        from .computer import computer
        host=runtime.host
        if not host:raise ValueError('Application executor unavailable')
        with self.lock:
            generation=self.generation
            self.validate(generation,client,lease)
            if self.plugin!='computer':raise ValueError('Desktop frame scope required')
            params={'command':{'action':'observe'},'bindingId':self.session_id,'permit':host.permit('native-frame')}
        result=host.request('native.observe',params)
        with self.lock:
            self.validate(generation,client,lease)
            raw=base64.b64decode(result['data'],validate=True)
            return computer.capture(raw,computer.generation)

    def stop(self,reason='stopped'):
        host=runtime.host
        with self.lock:
            if self.stopping:return self.status()
            had_binding=self.target is not None or self.stop_unconfirmed
            if had_binding and self.plugin=='computer':
                from .computer import computer
                computer.stop(reason)
            self.generation+=1
            from .app_permissions import permissions
            if self.grant: permissions.revoke_grant(self.grant)
            if self.pending_request: permissions.revoke_request(self.pending_request)
            self.target=self.grant=self.pending=None
            self.pending_request=None
            self.session_id=None
            self.stopping=True
        try:
            if host and had_binding:host.request('native.stop')
        except Exception:
            with self.lock:self.stop_unconfirmed=True
            raise
        else:
            with self.lock:self.stop_unconfirmed=False
        finally:
            with self.lock:self.stopping=False
        return self.status()

native_control=NativeControl()

from .app_permissions import permissions
def _revoke_application(app_id):
    if native_control.grant and native_control.grant['appId']==app_id:
        native_control.stop('permission-revoked')
permissions.on_revoke=_revoke_application
