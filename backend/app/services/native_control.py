"""Existing-application control; one coordinator, explicit application grants."""
import threading
import math
import time
from .coordinator import runtime
from . import vision, activities
from .app_permissions import permissions
from ..core import state

class NativeControl:
    def __init__(self):
        self.lock=threading.RLock()
        # Serialize captures and model actions without delaying stop/revocation.
        self.operation=threading.RLock()
        self.target=None
        self.grant=None
        self.generation=0
        self.plugin='computer'
        self.stop_unconfirmed=False
        self.stopping=False
        self.session_id=None
        self.observation=None
        self.projection=None

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
        return self.available_targets()

    def available_targets(self):
        version, blocked = permissions.before_action()
        result = runtime.host.request('native.targets')
        permissions.before_action(version=version)
        return {**result, 'targets': [
            row for row in result['targets']
            if row.get('bundleId') and row['bundleId'].lower() not in blocked
        ]}

    def status(self):
        with self.lock:
            return {'active': self.target is not None, 'target': self.target,
                    'generation': self.generation, 'plugin': self.plugin,
                    'permissions': sorted(self.grant['capabilities']) if self.grant else [],
                    'stopUnconfirmed': self.stop_unconfirmed, 'stopping': self.stopping}

    def start(self,window,pid,capabilities,client,lease,plugin='computer'):
        if plugin not in ('computer','browser') or not set(capabilities)<= {'observe','interact'} or 'observe' not in capabilities:
            raise ValueError('Invalid application scope')
        if not runtime.host:
            raise ValueError('Application executor unavailable')
        with runtime.host.control, self.lock:
            if (self.target and not self.stop_unconfirmed and not self.stopping
                    and plugin == self.plugin and window == self.target['windowId']
                    and pid == self.target['ownerPid']
                    and set(capabilities) <= set(self.grant['capabilities'])):
                self.validate(self.generation,client,lease)
                return self.status()
            if self.target or self.stop_unconfirmed or self.stopping:
                raise ValueError('Stop the current application activity first')
            from .minecraft import minecraft
            if minecraft.binding:
                raise ValueError('Another activity owns attention')
            self.plugin=plugin
            self.gate(client,lease)
            version,_=permissions.before_action()
            result=runtime.host.request('native.targets')
            target=next((row for row in result['targets'] if row.get('windowId')==window and row.get('ownerPid')==pid), None)
            if not target or not target.get('bundleId') or not target.get('path'):
                raise ValueError('Target window no longer exists')
            permissions.before_action(target,version)
            started=runtime.host.request('native.start',{
                'windowId':window,'ownerPid':pid,'permissions':capabilities,
                'bundleId':target['bundleId'],'path':target['path'],
                'permit':runtime.host.permit('native-start'),
            })
            self.session_id=started['bindingId']
            self.target=target
            self.grant={'capabilities':list(capabilities),'policyVersion':version}
            self.epoch=runtime.epoch
            self.fingerprint=vision.fingerprint(state.load()['settings']['llm'])
            self.generation+=1
            return self.status()

    def validate(self,generation,client=None,lease=None):
        self.gate(client,lease,allow_busy=True)
        if not self.target or generation!=self.generation or self.epoch!=runtime.epoch or self.fingerprint!=vision.fingerprint(state.load()['settings']['llm']):
            raise ValueError('Application grant changed')
        permissions.before_action(self.target,self.grant['policyVersion'])

    def bind_observation(self,generation,version,dimensions):
        """Bind provider image coordinates to this exact authorized window observation."""
        with self.lock:
            self.validate(generation)
            observed=self.observation
            width,height=dimensions.get('width'),dimensions.get('height')
            if (not isinstance(version,int) or isinstance(version,bool) or version<1
                    or not observed or observed['version']!=version or observed['generation']!=generation
                    or not isinstance(width,int) or not isinstance(height,int) or not 0<width<=1536 or not 0<height<=1536):
                raise ValueError('Observation mapping unavailable')
            bounds=observed['bounds']
            if not isinstance(bounds,dict) or any(not isinstance(bounds.get(k),(int,float)) or not math.isfinite(bounds[k]) or bounds[k]<=0 for k in ('width','height')):
                raise ValueError('Observation mapping unavailable')
            self.projection={**observed,'imageWidth':width,'imageHeight':height}
            return {'imageWidth':width,'imageHeight':height,'coordinateSpace':'image-pixels'}

    def _map_coordinates(self,command,version):
        projection=self.projection
        if (not isinstance(version,int) or isinstance(version,bool)
                or not projection or projection['version']!=version or projection['generation']!=self.generation
                or time.monotonic()-projection['observed']>15):
            raise ValueError('Observation mapping unavailable')
        x,y=command.get('x'),command.get('y')
        if (any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) for v in (x,y))
                or not 0<=x<projection['imageWidth'] or not 0<=y<projection['imageHeight']):
            raise ValueError('Invalid observation coordinate')
        return {**command,'x':x*projection['bounds']['width']/projection['imageWidth'],
                'y':y*projection['bounds']['height']/projection['imageHeight']}

    def execute(self,command,version=None):
        with self.operation:
            return self._execute(command,version)

    def _execute(self,command,version=None):
        host=runtime.host
        if not host:raise ValueError('Application executor unavailable')
        with self.lock:
            generation=self.generation
            self.validate(generation)
            method='native.observe' if command['action']=='observe' else 'native.action'
            if command['action'] != 'observe' and 'interact' not in self.grant['capabilities']:
                raise ValueError('Interaction not granted')
            if command['action'] in ('click','scroll'):command=self._map_coordinates(command,version)
            self.projection=None
            params={'command':command,'version':version,'bindingId':self.session_id,'permit':host.permit('native-action')}
        result=host.request(method,params)
        with self.lock:
            self.validate(generation)
            self.observation={"version":result.get("version"),"bounds":result.get("bounds"),"generation":generation,"observed":time.monotonic()} if command["action"]=="observe" else None
            return result

    def frame(self,client,lease):
        # Compatibility endpoint: desktop sense never consumes an input binding/version.
        from .computer import computer
        runtime.require_meeting(client,lease)
        return computer.desktop_frame()

    def stop(self,reason='stopped'):
        host=runtime.host
        with self.lock:
            if self.stopping:return self.status()
            had_binding=self.target is not None or self.stop_unconfirmed
            self.generation+=1
            self.target=self.grant=None
            self.session_id=None
            self.observation=self.projection=None
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
