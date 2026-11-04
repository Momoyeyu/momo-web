"""Lease-authorized offline browser commands in the shared Cordis host."""
import threading
from .coordinator import runtime
from . import vision, browser_fetch
from ..core import state

class BrowserError(ValueError): pass

class Browser:
    def __init__(self):
        self.lock = threading.RLock()
        self.generation = 0
        self.permissions = set()
        self.epoch = None
        self.allowedHosts = []
        self.fetches = 0

    def stop(self, reason='stopped', notify=True):
        with self.lock:
            self.generation += 1
            self.permissions.clear()
            self.allowedHosts = []
        if notify and runtime.host:
            runtime.host.request('browser.stop', timeout=25)
        return {'stopped':True,'generation':self.generation}

    def status(self):
        result = runtime.host.request('browser.status') if runtime.host else {'active':False}
        return {**result,'generation':self.generation,'permissions':sorted(self.permissions),'networkAvailable':False,'allowedHosts':list(self.allowedHosts)}

    def gate(self, client, lease):
        run_id = None
        if client is None:
            from .computer_tools import require_local
            run_id = require_local()
        else: runtime.require_meeting(client,lease)
        if not runtime.started or runtime.mode != 'meeting' or runtime.focus or runtime.restoring or runtime.interrupt_hold:
            raise BrowserError('Browser attention unavailable')
        from .computer import computer
        from .minecraft import minecraft
        other_presentation = runtime.presentation and (client is not None or runtime.presentation.get('runId') != run_id)
        if (runtime.active and client is not None) or other_presentation or computer.observing or minecraft.binding:
            raise BrowserError('Another activity owns attention')
        cfg = state.load()['settings']['llm']
        vision.require_enabled(cfg)
        return vision.fingerprint(cfg)

    def start(self, permissions, client, lease, allowed_hosts=None):
        if not runtime.host: raise BrowserError('Plugin host unavailable')
        hosts = browser_fetch.domains(allowed_hosts or [])
        with runtime.host.control:
            fingerprint = self.gate(client,lease)
            self.stop()
            permit = runtime.host.permit('browser-start')
            permit['expiresAt'] += 15000
            runtime.host.request('browser.start', {'permit':permit},timeout=25)
            try: self.gate(client,lease)
            except Exception:
                self.stop()
                raise
            with self.lock:
                self.permissions = set(permissions)
                self.allowedHosts = hosts
                self.fetches = 0
                self.epoch, self.fingerprint = runtime.epoch, fingerprint
            return self.status()

    def open(self, url, generation, client, lease):
        if not runtime.host: raise BrowserError('Plugin host unavailable')
        with self.lock:
            hosts = list(self.allowedHosts)
        def validate():
            fingerprint = self.gate(client,lease)
            with self.lock:
                if (generation != self.generation or self.epoch != runtime.epoch or fingerprint != self.fingerprint
                        or 'observe' not in self.permissions or not hosts or hosts != self.allowedHosts):
                    raise BrowserError('Browser navigation grant revoked')
        validate()
        with self.lock:
            if self.fetches >= 12: raise BrowserError('Page request budget exhausted')
            self.fetches += 1
        # Never hold host control during network IO: revoke must stop the renderer immediately.
        content, final_url = browser_fetch.fetch(url, hosts, validate)
        if len(content) > 100000: raise BrowserError('Page exceeds renderer text budget')
        validate()
        with runtime.host.control:
            validate()
            permit = runtime.host.permit('browser-open')
            result = runtime.host.request('browser.action', {'command':{'action':'load','html':content},'permit':permit},timeout=25)
            validate()
            return {**result,'generation':generation,'url':final_url}

    def execute(self, command, version, generation, client, lease):
        if not runtime.host: raise BrowserError('Plugin host unavailable')
        with runtime.host.control:
            fingerprint = self.gate(client,lease)
            with self.lock:
                if (generation != self.generation or self.epoch != runtime.epoch or fingerprint != self.fingerprint
                        or 'observe' not in self.permissions or command['action'] != 'observe' and 'interact' not in self.permissions):
                    raise BrowserError('Browser grant revoked or capability denied')
                permit = runtime.host.permit('browser-action')
            result = runtime.host.request('browser.action', {'command':command,'version':version,'permit':permit},timeout=25)
            self.gate(client,lease)
            if generation != self.generation: raise BrowserError('Late browser result discarded')
            return {**result,'generation':generation}

browser = Browser()
