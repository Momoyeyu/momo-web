"""Hash-only budget calibration; never a conversation or authorization cache.

A provider's measured WHOLE prompt is an upper bound for its unchanged leading
text messages. Charge every later/new message and image in full conservative
bytes. Do not guess a tokenizer ratio or subtract the removed old suffix.
"""
from collections import OrderedDict
import copy
import hashlib
import json
import threading
import time
from .context_policy import estimate, estimate_request, fingerprint


class MeasuredPrefixes:
    def __init__(self, *, ttl=300, clock=None):
        self.ttl = ttl
        self.clock = clock or time.monotonic
        self.lock = threading.Lock()
        self.records = OrderedDict()

    @staticmethod
    def _prefix(messages):
        if not messages or messages[0].get('role') != 'system':
            return ()
        result = []
        for message in messages[:64]:
            # Stop before multimodal content. Pixel reservations and fresh
            # observations must remain fully charged, even for identical URLs.
            if not isinstance(message.get('content'), str):
                break
            raw = json.dumps(message, ensure_ascii=False, sort_keys=True).encode()
            result.append(hashlib.sha256(raw).digest())
        return tuple(result)

    @staticmethod
    def _key(cfg, tools, scope):
        return scope, fingerprint(cfg), fingerprint(tools or [])

    def remember(self, messages, cfg, tools, scope, tokens):
        if type(tokens) is not int or tokens <= 0:
            return
        headers = self._prefix(messages)
        if not headers:
            return
        key, now = self._key(cfg, tools, scope), self.clock()
        with self.lock:
            rows = [row for row in self.records.get(key, []) if now - row[0] <= self.ttl]
            rows.append((now, headers, tokens))
            self.records[key] = rows[-8:]
            self.records.move_to_end(key)
            while len(self.records) > 32:
                self.records.popitem(last=False)

    def restore(self, messages, cfg, tools, scope):
        headers = self._prefix(messages)
        if not headers:
            return False
        key, now = self._key(cfg, tools, scope), self.clock()
        with self.lock:
            rows = tuple(self.records.get(key, []))
        bound, best = estimate_request(messages, tools), None
        for at, previous, tokens in rows:
            if now - at > self.ttl:
                continue
            count = 0
            for old, current in zip(previous, headers):
                if old != current:
                    break
                count += 1
            if not count:
                continue
            candidate = tokens + estimate(messages[count:])
            if candidate < bound:
                bound, best = candidate, (count, tokens)
        if best is None:
            return False
        count, tokens = best
        # Only CURRENT messages enter the request-local anchor. Historical text
        # is not stored, reconstructed, authorized or sent by this cache.
        messages.usage_anchor = (copy.deepcopy(list(messages[:count])), copy.deepcopy(tools), tokens)
        return True


measured_prefixes = MeasuredPrefixes()
