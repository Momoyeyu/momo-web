"""Ephemeral selected-source observations; reasoning stays in Python's attention lane."""
import base64
import hashlib
import io
import json
from PIL import Image, ImageStat
import threading
import time

from ..core import state, db
from . import vision
from .coordinator import runtime

class ComputerError(ValueError):
    pass

class Computer:
    def __init__(self):
        self.lock = threading.RLock()
        self.generation = 0
        self.observing = False
        self.frame = None
        self.source = ''
        self.shared_source = False
        self.reason = 'stopped'
        self.proactive = self.reactions = False
        self.frames = 0
        self.last = 0
        self.digest = ''
        self.signature = None
        self.reacted_signature = None
        self.last_reaction = 0
        self.analyses = 0
        self.expiry = None
        self.desktop_allowed = True
        self.desktop_error = ''
        self.capture_lock = threading.Lock()

    def reload_preferences(self):
        """Only preferences cross boot/restore; never retain pixels or a running observation."""
        with self.lock:
            try:
                data = json.loads(db.meta_get('computer_preferences', '{}'))
            except (ValueError, TypeError):
                data = {}
            if not isinstance(data, dict): data = {}
            self.proactive = data.get('proactive') is True
            self.reactions = data.get('reactions') is True
            self.desktop_allowed = data.get('desktopAllowed') is not False
            self.desktop_error = ''
            self.stop('preferences_reloaded')

    def _persist_preferences(self):
        with db.tx() as connection:
            connection.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('computer_preferences',?)",
                (json.dumps(dict(proactive=self.proactive, reactions=self.reactions, desktopAllowed=self.desktop_allowed)),))

    def configure(self, proactive, reactions):
        with self.lock:
            self.proactive, self.reactions = proactive, reactions
            self._persist_preferences()
            return self.snapshot()

    def stop(self, reason='stopped'):
        with self.lock:
            if self.expiry:
                self.expiry.cancel()
                self.expiry = None
            self.generation += 1
            self.observing = False
            self.frame = None
            self.reason = reason
            return self.snapshot(check=False)

    def gate(self):
        from .activities import require_enabled
        try: require_enabled('computer')
        except ValueError as error: raise ComputerError(str(error)) from None
        from .minecraft import minecraft
        if minecraft.binding:
            raise ComputerError('computer.attention')
        cfg = state.load()['settings']['llm']
        if (not runtime.started or runtime.mode != 'meeting' or runtime.focus
                or runtime.restoring):
            self.stop('attention')
            raise ComputerError('computer.attention')
        if self.observing and (runtime.epoch != self.epoch or vision.fingerprint(cfg) != self.fingerprint):
            self.stop('revoked')
            raise ComputerError('computer.revoked')
        try: vision.require_enabled(cfg)
        except vision.VisionError:
            self.stop("vision")
            raise
        return cfg

    def snapshot(self, check=True):
        with self.lock:
            if check and self.observing:
                try: self.gate()
                except (ComputerError, vision.VisionError): self.stop('revoked')
            if self.frame and time.monotonic()-self.last > 15: self.frame = None
            return dict(observing=self.observing,generation=self.generation,source=self.source,
                        proactive=self.proactive,reactions=self.reactions,frames=self.frames,
                        reason=self.reason,executionAvailable=False,proactiveAvailable=True,
                        observationAvailable=self.frame is not None,desktopAllowed=self.desktop_allowed,desktopError=self.desktop_error)

    def start(self, source, proactive=False, reactions=False, *, shared=True):
        with self.lock:
            self.stop()
            cfg = self.gate()
            runtime.host.request('computer.start', {'source':source})
            self.epoch = runtime.epoch
            self.fingerprint = vision.fingerprint(cfg)
            self.source, self.proactive, self.reactions = source, proactive, reactions
            self._persist_preferences()
            self.shared_source = shared
            self.frames, self.last, self.digest = 0, 0, ''
            self.signature = self.reacted_signature = None
            self.last_reaction = self.analyses = 0
            self.started_at = time.monotonic()
            self.observing, self.reason = True, ''
            return self.snapshot()

    def desktop_frame(self):
        """Read-only view of the visible display, independent of application grants."""
        with self.capture_lock:
            with self.lock:
                self.gate()
                if not self.desktop_allowed: raise ComputerError('computer.paused')
                if not self.observing:
                    self.start('Desktop',self.proactive,self.reactions,shared=False)
                generation = self.generation
                if self.shared_source:
                    if self.frame and time.monotonic()-self.last < 15: return self.snapshot()
                    raise ComputerError('computer.observationExpired')
                if self.frame and time.monotonic()-self.last < 2:
                    return self.snapshot()
            try:
                result = runtime.host.request('native.screen',{'permit':runtime.host.permit('desktop-observe'),'prompt':self.desktop_error != 'screen-permission'})
                raw = base64.b64decode(result['data'],validate=True)
                with self.lock:
                    self.gate()
                    if generation != self.generation or not self.desktop_allowed:
                        raise ComputerError('computer.revoked')
                    self.capture(raw,generation,continuous=True)
                    self.desktop_error = ''
                    return self.snapshot()
            except Exception as error:
                with self.lock:
                    if generation == self.generation:
                        self.desktop_error = 'screen-permission' if str(error)=='SCREEN_PERMISSION_REQUIRED' else 'capture'
                raise

    def set_desktop_allowed(self, enabled):
        with self.lock:
            self.desktop_allowed = enabled
            self._persist_preferences()
            self.desktop_error = ''
            if not enabled: self.stop('paused')
            return self.snapshot()

    def expire_frame(self, generation, observed):
        with self.lock:
            if self.generation == generation and getattr(self,"observed",None) == observed:
                self.frame = None

    def capture(self, raw, generation, *, continuous=False):
        with self.lock:
            self.gate()
            if not self.observing or generation != self.generation: raise ComputerError('computer.revoked')
            if not continuous and (self.frames >= 120 or time.monotonic()-self.started_at > 600):
                self.stop('budget')
                raise ComputerError('computer.budget')
            if time.monotonic()-self.last < 2: raise ComputerError('computer.rate')
            data, width, height, _ = vision.normalize(raw)
            digest = hashlib.sha256(data).hexdigest()
            pixels = Image.open(io.BytesIO(data)).convert("L").resize((16,16))
            self.signature = tuple(pixels.tobytes())
            self.unknown = ImageStat.Stat(pixels).mean[0] < 3
            self.frame = data
            self.last, self.observed = time.monotonic(), time.time()
            if self.expiry: self.expiry.cancel()
            self.expiry = threading.Timer(15, self.expire_frame, (self.generation,self.observed))
            self.expiry.daemon = True
            self.expiry.start()
            self.frames += 1
            changed = digest != self.digest
            self.digest = digest
            return dict(generation=self.generation,observedAt=self.observed,source=self.source,changed=changed,width=width,height=height)

    def claim_reaction(self, generation, client, lease):
        """Atomically reserve an optional reaction, without enqueueing suppressed work."""
        runtime.require_meeting(client, lease)
        with runtime.condition, self.lock:
            self.gate()
            different = self.reacted_signature is None or (self.signature is not None and sum(abs(a-b) for a,b in zip(self.signature,self.reacted_signature))/256 > 8)
            if (generation != self.generation or not self.observing or not self.frame
                    or time.monotonic()-self.last > 15 or not self.proactive or not self.reactions
                    or not different or getattr(self, "unknown", True) or self.analyses >= 12
                    or time.monotonic()-self.last_reaction < 30 or runtime.active or runtime.presentation or runtime.queue
                    or runtime.interrupt_hold):
                return None
            self.last_reaction = time.monotonic()
            self.reacted_signature = self.signature
            return {"generation": generation}

    def stage_reaction(self, generation):
        """Project pixels once into the regular turn, never a separate inference."""
        from .computer_tools import stage
        with self.lock:
            def validate():
                self.gate()
                if (generation != self.generation or not self.observing or not self.proactive
                        or not self.reactions or not self.frame or time.monotonic()-self.last > 15):
                    raise ComputerError('computer.revoked')
            validate()
            if self.analyses >= 12: raise ComputerError('computer.budget')
            self.analyses += 1
            stage(self.frame, validate)
            return {"source": self.source, "observedAt": self.observed}


computer = Computer()
