"""Bounded ACT tokenizer. Control data never becomes spoken text.

ACT semantics adapted from AIRI (MIT), commit 3ecb515de13d70fe67b74a7fa5a80b9c4e59149e.
See THIRD_PARTY_NOTICES.md. Tokenization remains local to momo's sentence pipeline.
"""
from __future__ import annotations

import json
import logging
import math
from typing import Any

PREFIX = '<|ACT '
LIMIT = 2048
log = logging.getLogger(__name__)


def normalize_act(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    result = {}
    if 'expression' in value:
        exp = value['expression']
        if exp is None:
            result['expression'] = None
        elif isinstance(exp, dict) and isinstance(exp.get('name'), str) and 0 < len(exp['name']) <= 128:
            intensity = exp.get('intensity', 1)
            duration = exp.get('duration')
            finite = lambda x: isinstance(x, (float, int)) and not isinstance(x, bool) and math.isfinite(x)
            if finite(intensity) and (duration is None or (finite(duration) and 0.1 <= duration <= 30)):
                result['expression'] = {'name': exp['name'], 'intensity': max(0.0, min(1.0, intensity))}
                if duration is not None:
                    result['expression']['duration'] = duration
    motion = value.get('motion')
    if isinstance(motion, str) and 0 < len(motion) <= 256:
        result['motion'] = motion
    return result


class ActStream:
    def __init__(self):
        self.pending = ''
        self.body: str | None = None
        self.discard = False
        self.quoted = False
        self.escaped = False
        self.tail = ''

    def push(self, text: str) -> list[str | dict]:
        out: list[str | dict] = []
        plain = ''
        for ch in text:
            if self.body is None:
                self.pending += ch
                while self.pending and not PREFIX.startswith(self.pending):
                    plain += self.pending[0]
                    self.pending = self.pending[1:]
                if self.pending == PREFIX:
                    if plain:
                        out.append(plain)
                        plain = ''
                    self.pending = ''
                    self.body = ''
                    self.tail = ''
                    self.quoted = self.escaped = self.discard = False
                continue
            self.tail = (self.tail + ch)[-len(PREFIX):]
            # A new raw prefix is a synchronization point, even in malformed JSON.
            if self.tail == PREFIX:
                self.body = ''
                self.tail = ''
                self.quoted = self.escaped = self.discard = False
                log.warning('performance: invalid ACT restarted')
                continue
            if not self.discard:
                self.body += ch
            if self.tail.endswith('|>') and (self.discard or not self.quoted):
                if not self.discard:
                    try:
                        payload = normalize_act(json.loads(self.body[:-2]))
                        if payload:
                            out.append(payload)
                    except (ValueError, TypeError):
                        log.warning('performance: invalid ACT discarded')
                self.body = None
                self.tail = ''
                continue
            if self.discard:
                continue
            if len(self.body) > LIMIT:
                self.body = ''
                self.discard = True
                log.warning('performance: oversized ACT discarded')
                continue
            if self.escaped:
                self.escaped = False
            elif self.quoted and ch == '\\':
                self.escaped = True
            elif ch == '"':
                self.quoted = not self.quoted
        if plain:
            out.append(plain)
        return out

    def flush(self) -> list[str | dict]:
        out = [self.pending] if self.pending else []
        if self.body is not None:
            log.warning('performance: truncated ACT discarded')
        self.__init__()
        return out


def allowed_act(payload: dict, presentation: dict | None) -> dict:
    if not presentation:
        return {}
    result = {}
    if 'expression' in payload:
        exp = payload['expression']
        if exp is None or any(e['name'] == exp['name'] for e in presentation['expressions']):
            result['expression'] = exp
    if 'motion' in payload and any(m['name'] == payload['motion'] for m in presentation['motions']):
        result['motion'] = payload['motion']
    return result
