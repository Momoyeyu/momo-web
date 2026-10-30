"""Provider-neutral context budget and bounded numeric policy (no model decisions).

Unknown providers use an explicit conservative fallback, never a DeepSeek guess.
UTF-8 bytes conservatively estimate text tokens; usage anchors improve observations,
not the hard request safety check. Policies contain aggregates only, no chat text.
"""
from dataclasses import dataclass
import hashlib
import json
import math
import time
from ..core import db


def estimate(messages, tools=None):
    if messages and 'text' in messages[0]:
        messages = [{'role': r['role'], 'content': r['text']} for r in messages]
    return len(json.dumps({'messages': messages, 'tools': tools or []}, ensure_ascii=False).encode('utf-8')) + 64


@dataclass(frozen=True)
class Budget:
    window: int
    output: int
    safe: int
    soft: int

    @classmethod
    def from_config(cls, cfg):
        def positive(key, default):
            try:
                n = int(cfg.get(key, default))
                return n if n > 0 else default
            except (ValueError, TypeError):
                return default
        window = positive('contextWindow', 32768)
        output = positive('maxOutputTokens', 4096)
        safe = max(1, window - output - math.ceil(window * .08))
        # Reserve ongoing growth while asynchronous summary is in flight.
        return cls(window, output, safe, max(1, safe - math.ceil(window * .22)))


def fingerprint(cfg):
    # Do not store credentials; changing them still invalidates a candidate.
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()


def choose_latest(rows, k):
    runs = list(dict.fromkeys(r['run_id'] for r in rows))
    keep = set(runs[-k:])
    return next((i for i, r in enumerate(rows) if r['run_id'] in keep), len(rows))


def atomic(method):
    def wrapped(self, *args, **kwargs):
        with db._lock:
            self.data = json.loads(db.meta_get(self.key, '{}'))
            return method(self, *args, **kwargs)
    return wrapped


class Policy:
    """Versioned per-provider/audience aggregates; conservative baseline until settled.

    Four subsequent request observations form a feedback horizon. Early capacity
    failure settles risk immediately; truncated windows remain censored. Cold
    candidates are shadow-only: sparse traffic cannot establish safe exploration.
    """
    def __init__(self, cfg, audience, tools=None):
        self.key = 'context-policy-v1:' + fingerprint(cfg) + ':' + hashlib.sha256((audience + json.dumps(tools or [], sort_keys=True)).encode()).hexdigest()
        try:
            self.data = json.loads(db.meta_get(self.key, '{}'))
        except (ValueError, TypeError):
            self.data = {}

    def save(self):

        with db.tx() as c:
            c.execute('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (self.key, json.dumps(self.data)))

    def soft_limit(self, budget):
        samples = self.data.get('compact_growth', [])
        # A sparse sample never lowers the cold-start reserve.
        reserve = budget.window * .22
        if len(samples) >= 32:
            ordered = sorted(samples)
            reserve = max(budget.window * .12, ordered[math.ceil(.99 * len(ordered))-1] + budget.window * .08)
        return max(1, min(budget.soft + budget.window * .1, budget.safe - reserve))

    @atomic
    def record_request(self, size, usage=None):
        old = self.data.get('last_size', size)
        self.data['growth'] = (self.data.get('growth', []) + [max(0, size-old)])[-128:]
        self.data['last_size'] = size
        self.save()

    @atomic
    def record_usage(self, usage):
        for key in ('prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'):
            self.data['foreground_' + key] = self.data.get('foreground_' + key, 0) + int(usage.get(key) or 0)
        self.save()

    def ready(self):
        return time.time() >= self.data.get('retry_after', 0)

    @atomic
    def select(self, rows, budget, overhead=0):
        """Shadow every candidate; live selection stays near conservative baseline.

        Candidate feasibility uses actual retained bytes + conservative summary
        estimate. No LLM decides retention; no sampled candidate bypasses safety.
        """
        previous = self.latest()
        scores = []
        for k in range(2, 9):
            cut = choose_latest(rows, k)
            if cut < 2:
                continue
            old = estimate(rows[:cut])
            after = overhead + estimate(rows[cut:]) + max(512, old * .35)
            if after > self.soft_limit(budget):
                continue
            free = (budget.safe-after)/budget.window
            health = max(0, .2-free)**2 + .25*max(0, free-.55)**2
            switch = .02 * abs(k-previous)/6
            scores.append((health+switch, k))
        self.data['shadow'] = [{'k': k, 'loss': loss} for loss,k in scores]
        # Risk credible upper bound for Beta(1,b) with no observed failures.
        # Other posteriors conservatively disable exploration in this first version.
        adjacent = []
        for loss, k in scores:
            stats = self.data.get('candidates', {}).get(str(k), {})
            beta = stats.get('beta', 1)
            upper = 1 - .05**(1/beta) if stats.get('alpha',1) == 1 else 1
            if beta >= 33 and upper < .1 and abs(k-previous) <= 1:
                adjacent.append((loss,k))
        if adjacent:
            self.data['latest'] = min(adjacent)[1]
        self.save()
        feasible = {k for _,k in scores}
        return self.latest() if self.latest() in feasible else min(feasible, default=None)

    def latest(self):
        return max(2, min(8, int(self.data.get('latest', 4))))

    @atomic
    def observe(self, pressure, *, risk=False):
        active = self.data.get('active')
        if not active or active.get('settled'):
            return
        if risk:
            active['settled'] = True
            self.data['risk_alpha'] = self.data.get('risk_alpha', 1) + 1
            candidate = self.data.setdefault('candidates', {}).setdefault(str(active['k']), {})
            candidate['alpha'] = candidate.get('alpha',1)+1
            self.data['latest'] = max(2, self.latest() - 1)
        elif active.get('published'):
            active['observations'] += 1
            if active['observations'] >= 4:
                active['settled'] = True
                self.data['risk_beta'] = self.data.get('risk_beta', 1) + 1
                candidate = self.data.setdefault('candidates', {}).setdefault(str(active['k']), {})
                candidate['beta'] = candidate.get('beta',1)+1
                self.data['settled_horizons'] = self.data.get('settled_horizons',0) + 1
        self.save()

    @atomic
    def start(self, action):
        self.data['active'] = {'id': action, 'k': self.latest(), 'published': False, 'observations': 0, 'settled': False, 'initial_size': self.data.get('last_size',0)}
        self.data['attempts'] = self.data.get('attempts', 0) + 1
        self.save()

    @atomic
    def finish(self, *, published, duration, usage):
        if self.data.get('active'):
            self.data['active']['published'] = published
        active = self.data.get('active', {})
        growth = max(0, self.data.get('last_size',0)-active.get('initial_size',0))
        self.data['compact_growth'] = (self.data.get('compact_growth', []) + [growth])[-128:]
        self.data['durations'] = (self.data.get('durations', []) + [duration])[-128:]
        self.data['consecutive_failures'] = 0 if published else self.data.get('consecutive_failures',0)+1
        self.data['retry_after'] = 0 if published else time.time() + min(300, 5 * 2**min(6,self.data['consecutive_failures']))
        self.data['duration_max'] = max(self.data.get('duration_max', 0), duration)
        self.data['failures'] = self.data.get('failures', 0) + int(not published)
        for key in ('prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'):
            self.data[key] = self.data.get(key, 0) + int(usage.get(key) or 0)
        self.save()
