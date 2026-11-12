"""Authorized Fabric execution in the existing coordinator, without a reasoning loop."""
import threading
import time
from ..core import state
from .coordinator import runtime
from . import vision

class MinecraftError(ValueError):
    pass

class Minecraft:
    def __init__(self):
        self.lock = threading.RLock()
        self.generation = 0
        self.binding = None
        self.permissions = set()
        self.epoch = None
        self.actions = 0
        self.budget_window = time.monotonic()

    def stop(self, reason='stopped', notify=True):
        with self.lock:
            self.generation += 1
            self.permissions.clear()
            self.binding = None
        if notify and runtime.host:
            return runtime.host.request('minecraft.stop')
        return {'stopped': True, 'generation': self.generation}

    def status(self):
        result = runtime.host.request('minecraft.status') if runtime.host else {'available': False}
        # Binding authority is separate from the adapter's last action/stop state.
        with self.lock:
            return {**result, 'active': self.binding is not None, 'generation': self.generation,
                    'permissions': sorted(self.permissions), 'managedProvisioningAvailable': False}

    def gate(self, client, lease):
        from .activities import require_enabled
        try: require_enabled('minecraft')
        except ValueError as error: raise MinecraftError(str(error)) from None
        if client is None:
            from .computer_tools import require_local
            require_local()
        else: runtime.require_meeting(client, lease)
        if not runtime.started or runtime.mode != 'meeting' or runtime.focus or runtime.restoring or (runtime.interrupt_hold and client is not None):
            raise MinecraftError('Minecraft attention unavailable')
        from .computer import computer
        from .browser import browser
        from .native_control import native_control
        if (runtime.active and client is not None) or computer.observing or browser.permissions or native_control.target or native_control.stopping or native_control.stop_unconfirmed:
            raise MinecraftError('Another activity owns attention')
        cfg = state.load()['settings']['llm']
        vision.require_enabled(cfg)
        return vision.fingerprint(cfg)

    def connect(self, port, token, world, account, permissions, client, lease):
        # Explicit user binding only. Credentials are passed privately, never saved or returned.
        with runtime.host.control:
            fingerprint = self.gate(client, lease)
            self.stop()
            runtime.host.request('minecraft.configure', {'port': port, 'token': token})
            with self.lock:
                self.binding = {'world': world, 'account': account}
                self.permissions = set(permissions)
                self.actions = 0
                self.epoch, self.fingerprint = runtime.epoch, fingerprint
                return self.status()

    def execute(self, action, arguments, generation, client, lease):
        capability = {'observe':'game.observe', 'chat':'game.chat', 'follow':'game.move','play':'game.modify'}[action]
        # Host control serializes dispatch against the coordinator's revoke barrier.
        with runtime.host.control:
            fingerprint = self.gate(client, lease)
            with self.lock:
                if (generation != self.generation or self.epoch != runtime.epoch or not self.binding
                        or fingerprint != self.fingerprint or capability not in self.permissions or 'game.observe' not in self.permissions):
                    raise MinecraftError('Minecraft grant revoked or capability denied')
                if time.monotonic() - self.budget_window >= 60:
                    self.actions = 0
                    self.budget_window = time.monotonic()
                if self.actions >= 120:
                    raise MinecraftError('Minecraft action budget exhausted')
                self.actions += 1
                permission = {**self.binding, 'activityEpoch': runtime.epoch}
            result = runtime.host.request('minecraft.' + action, {**arguments, 'permission': permission})
            fingerprint = self.gate(client, lease)
            with self.lock:
                if generation != self.generation or self.epoch != runtime.epoch or fingerprint != self.fingerprint:
                    raise MinecraftError('Late Minecraft result discarded')
        # Wait outside the dispatch lock so Home, focus and Stop can revoke held input.
        if action == 'play':
            deadline = time.monotonic() + arguments.get('durationMs', 500) / 1000
            while time.monotonic() < deadline:
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
                with self.lock:
                    if generation != self.generation or self.epoch != runtime.epoch:
                        raise MinecraftError('Minecraft input interrupted')
            result = {**result, 'inputLeaseElapsed': True}
        return result

minecraft = Minecraft()
