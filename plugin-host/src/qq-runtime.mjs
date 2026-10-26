import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const PREFIX = 'MOMO_QQ_IPC ';
const safeId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const bounded = (value, maximum = 4096) => typeof value === 'string' && value.length <= maximum && !value.includes('\0');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messages = Object.freeze({
  OWNER_ACTION_REQUIRED: 'QQ login requires an explicit local owner action',
  RESOURCE_UNAVAILABLE: 'Managed QQ resources are not available',
  RESOURCE_INVALID: 'Managed QQ resources are not qualified',
  INPUT: 'Invalid QQ login action',
  ATTEMPT_CANCELLED: 'QQ login attempt was replaced or cancelled',
  RUNTIME_FAILED: 'Managed QQ runtime failed',
  RUNTIME_TIMEOUT: 'Managed QQ runtime did not respond',
  RUNTIME_NOT_QUIESCENT: 'Managed QQ runtime has not stopped',
  RUNTIME_STOPPED: 'Managed QQ runtime stopped',
  IPC_LIMIT: 'Managed QQ runtime exceeded its communication limit',
  IPC_PROTOCOL: 'Managed QQ runtime returned an invalid response',
  ACCOUNT_MISMATCH: 'The logged-in QQ account does not match the bound account',
  FORGET_UNAVAILABLE: 'Managed QQ session removal is not available',
  FORGET_FAILED: 'Managed QQ session could not be removed',
});
const knownErrorCode = value => typeof value === 'string' && Object.hasOwn(messages, value) ? value : 'RUNTIME_FAILED';
export class QQRuntimeError extends Error {
  constructor(code) { const safeCode = knownErrorCode(code); super(messages[safeCode]); this.name = 'QQRuntimeError'; this.code = safeCode; }
}
const failure = code => new QQRuntimeError(code);
const sanitizedError = cause => failure(knownErrorCode(cause?.code));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only trusted server code supplies prepareInvocation. No endpoint, process path,
// argv, environment, or management API is accepted by any public login action.
function preparedTransport(invocation) {
  if (!object(invocation) || invocation.command !== '/usr/bin/sandbox-exec' || !Array.isArray(invocation.args) || invocation.args.length < 1 || invocation.args.length > 128 || invocation.args.some(arg => !bounded(arg, 65536)) || !bounded(invocation.cwd) || !isAbsolute(invocation.cwd) || !object(invocation.env)) throw failure('RESOURCE_INVALID');
  const entries = Object.entries(invocation.env);
  if (entries.length > 64 || entries.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || !bounded(value, 32768)) || !isAbsolute(invocation.env.TMPDIR ?? '')) throw failure('RESOURCE_INVALID');
  // A detached process group is still exclusively owned here. It lets stop
  // reclaim SDK descendants after the direct parent has exited.
  const child = spawn(invocation.command, [...invocation.args], { cwd: invocation.cwd, env: { ...invocation.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true, windowsHide: true });
  const pgid = child.pid;
  return {
    child,
    killTree: signal => { if (Number.isSafeInteger(pgid) && pgid > 1) { try { process.kill(-pgid, signal); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; } } },
    isTreeStopped: () => {
      if (!Number.isSafeInteger(pgid) || pgid <= 1) return true;
      try { process.kill(-pgid, 0); return false; } catch (cause) { return cause.code === 'ESRCH'; }
    },
  };
}

/** Owns one QQ engine independently of channel policy and message adapters. */
export class QQRuntimeManager {
  #createTransport; #prepareInvocation; #forgetSession; #onState; #now;
  #requestTimeout; #stopTimeout; #maxFrameBytes;
  #child = null; #starting = null; #stopping = null; #forgetting = false;
  #state = 'idle'; #error = null; #attempt = null; #expectedSelfId = null; #actualSelfId = null; #qr = null; #qrTimer = null;
  #pending = new Map(); #generation = 0; #unquiescent = false; #cancelStart = false;
  #killTree = null; #treeStopped = null; #parentExited = false;

  constructor({ createTransport, prepareInvocation, forgetSession, onState = () => {}, now = Date.now, requestTimeoutMs = 10000, stopTimeoutMs = 1000, maxFrameBytes = 512 * 1024 } = {}) {
    this.#createTransport = createTransport;
    this.#prepareInvocation = prepareInvocation;
    this.#forgetSession = forgetSession;
    this.#onState = onState; this.#now = now;
    this.#requestTimeout = Math.max(10, Math.min(Number(requestTimeoutMs) || 10000, 30000));
    this.#stopTimeout = Math.max(10, Math.min(Number(stopTimeoutMs) || 1000, 5000));
    this.#maxFrameBytes = Math.max(1024, Math.min(Number(maxFrameBytes) || 512 * 1024, 1024 * 1024));
  }

  status({ authenticatedDetail = false } = {}) {
    this.#expireQR();
    const state = { provider: 'qq', status: this.#state, running: this.#child !== null, connected: this.#state === 'connected', actualSelfId: this.#actualSelfId, attemptId: this.#attempt, error: this.#error, executorQuiescent: this.#child === null && this.#starting === null };
    // The authenticated API explicitly opts in after authorizing the caller.
    if (authenticatedDetail === true) state.qr = this.#qr ? { ...this.#qr } : null;
    return state;
  }

  async begin({ ownerAction = false, expectedSelfId } = {}) {
    this.#owner(ownerAction);
    if (expectedSelfId !== undefined && expectedSelfId !== null && !safeId(expectedSelfId)) throw failure('INPUT');
    if (this.#unquiescent || this.#stopping || this.#forgetting) throw failure('RUNTIME_NOT_QUIESCENT');
    if (expectedSelfId !== undefined) this.#expectedSelfId = expectedSelfId;
    const previous = this.#attempt;
    this.#revoke('ATTEMPT_CANCELLED');
    const attemptId = randomUUID(); this.#attempt = attemptId; this.#actualSelfId = null;
    this.#transition('preparing');
    try {
      await this.#ensureStarted(); this.#assertAttempt(attemptId);
      if (previous) await this.#request('cancel', { attemptId: previous });
      this.#assertAttempt(attemptId);
      await this.#request('prepare', { attemptId }); this.#assertAttempt(attemptId);
      this.#transition('connecting');
      this.#applyResult(await this.#request('connect', { attemptId }), attemptId); this.#assertAttempt(attemptId);
      if (this.#state !== 'connected') {
        this.#transition('qr_pending');
        this.#applyResult(await this.#request('requestQr', { attemptId }), attemptId); this.#assertAttempt(attemptId);
      }
      return this.status();
    } catch (cause) {
      const error = sanitizedError(cause);
      if (this.#attempt === attemptId) this.#fail(error.code);
      throw error;
    }
  }

  async refreshQR({ ownerAction = false } = {}) { return this.begin({ ownerAction, expectedSelfId: this.#expectedSelfId }); }

  async cancel() {
    const attemptId = this.#attempt;
    this.#revoke('ATTEMPT_CANCELLED'); this.#actualSelfId = null; this.#transition('cancelled');
    if (attemptId && this.#child && !this.#stopping) {
      try { await this.#request('cancel', { attemptId }); }
      catch (cause) { if (!this.#attempt) this.#fail(sanitizedError(cause).code); }
    }
    return this.status();
  }

  async stop() {
    this.#cancelStart = true; this.#revoke('RUNTIME_STOPPED'); this.#actualSelfId = null;
    if (this.#stopping) return this.#stopping;
    const stopping = this.#stopOwned(); this.#stopping = stopping;
    try { return await stopping; }
    finally { if (this.#stopping === stopping) this.#stopping = null; }
  }

  async forget({ ownerAction = false } = {}) {
    this.#owner(ownerAction);
    if (this.#forgetting) throw failure('RUNTIME_NOT_QUIESCENT');
    this.#forgetting = true;
    try {
      const result = await this.stop();
      if (!result.executorQuiescent) throw failure('RUNTIME_NOT_QUIESCENT');
      if (typeof this.#forgetSession !== 'function') throw failure('FORGET_UNAVAILABLE');
      try { await this.#forgetSession(); } catch { throw failure('FORGET_FAILED'); }
      this.#expectedSelfId = null; this.#actualSelfId = null; this.#transition('idle');
      return this.status();
    } finally { this.#forgetting = false; }
  }

  #owner(allowed) { if (allowed !== true) throw failure('OWNER_ACTION_REQUIRED'); }
  #assertAttempt(attemptId) { if (attemptId !== this.#attempt || !this.#child || this.#unquiescent) throw failure('ATTEMPT_CANCELLED'); }
  #transition(status, code = null) { this.#state = status; this.#error = code; this.#notify(); }
  #notify() { try { this.#onState(this.status()); } catch { /* Observers cannot alter ownership. */ } }
  #clearQR() { this.#qr = null; clearTimeout(this.#qrTimer); this.#qrTimer = null; }
  #expireQR() {
    if (this.#qr && this.#qr.expiresAt <= this.#now()) { this.#clearQR(); if (this.#state !== 'connected') this.#state = 'expired'; }
  }
  #revoke(code) {
    const previous = this.#attempt; this.#attempt = null; this.#clearQR();
    for (const [id, pending] of this.#pending) if (pending.attemptId === previous && pending.method !== 'stop') { this.#pending.delete(id); clearTimeout(pending.timer); pending.reject(failure(code)); }
  }
  #fail(code) {
    this.#revoke(code); this.#actualSelfId = null; this.#transition(code === 'ACCOUNT_MISMATCH' ? 'identity_mismatch' : 'error', code);
  }

  async #ensureStarted() {
    if (this.#child) return;
    if (this.#starting) return this.#starting;
    const generation = ++this.#generation; this.#cancelStart = false;
    const starting = (async () => {
      let invocation;
      if (this.#prepareInvocation) {
        try { invocation = await this.#prepareInvocation(); }
        catch (cause) { throw sanitizedError(cause); }
      } else if (!this.#createTransport) throw failure('RESOURCE_UNAVAILABLE');
      if (this.#cancelStart) throw failure('RUNTIME_STOPPED');
      const transport = await (this.#createTransport ? this.#createTransport(invocation) : preparedTransport(invocation));
      const child = transport?.child ?? transport;
      if (!child || !child.stdin?.write || !child.stdout?.on || !child.stderr?.on || !child.on || !child.kill) { try { child?.kill?.('SIGKILL'); } catch {} throw failure('RUNTIME_FAILED'); }
      this.#child = child; this.#unquiescent = false; this.#parentExited = false;
      // A custom transport is trusted server code. A raw child is suitable only
      // when its factory guarantees no descendants; native transports provide
      // both tree callbacks, as the production process-group transport does.
      this.#killTree = transport?.killTree ?? (signal => child.kill(signal));
      this.#treeStopped = transport?.isTreeStopped ?? (() => this.#parentExited);
      this.#observe(child, generation);
      if (this.#cancelStart) { void this.stop(); throw failure('RUNTIME_STOPPED'); }
    })();
    this.#starting = starting;
    try { await starting; }
    finally {
      if (this.#starting === starting) this.#starting = null;
      if (this.#cancelStart && !this.#child) { this.#unquiescent = false; if (!this.#stopping) this.#transition('stopped'); }
    }
  }

  #observe(child, generation) {
    let line = Buffer.alloc(0), dropping = false;
    const current = () => child === this.#child && generation === this.#generation;
    const onData = input => {
      if (!current() || this.#parentExited) return;
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
        if (!dropping) {
          const part = chunk.subarray(offset, end);
          if (line.length + part.length > this.#maxFrameBytes) {
            const initial = Buffer.concat([line.subarray(0, PREFIX.length), part.subarray(0, PREFIX.length)]).toString('utf8', 0, PREFIX.length);
            if (initial.startsWith(PREFIX)) this.#fail('IPC_LIMIT');
            line = Buffer.alloc(0); dropping = true;
          } else line = Buffer.concat([line, part]);
        }
        if (newline < 0) break;
        if (!dropping && line.length) this.#frame(line.toString('utf8').replace(/\r$/, ''), child);
        line = Buffer.alloc(0); dropping = false; offset = newline + 1;
      }
    };
    child.stdout.on('data', onData);
    // Drain native diagnostics without retaining, logging, forwarding, or putting
    // them into an Error. They may contain session material and private paths.
    child.stderr.on('data', () => {});
    child.stdin.on?.('error', () => { if (current()) this.#fail('RUNTIME_FAILED'); });
    child.stdout.on('error', () => { if (current()) this.#fail('RUNTIME_FAILED'); });
    child.stderr.on('error', () => { if (current()) this.#fail('RUNTIME_FAILED'); });
    child.on('error', () => { if (current()) this.#fail('RUNTIME_FAILED'); });
    const close = () => {
      if (!current()) return;
      this.#parentExited = true; line = Buffer.alloc(0);
      for (const [id, pending] of this.#pending) { this.#pending.delete(id); clearTimeout(pending.timer); pending.reject(failure('RUNTIME_STOPPED')); }
      this.#revoke('RUNTIME_STOPPED'); this.#actualSelfId = null;
      if (!this.#releaseStoppedTree(child)) this.#unquiescent = true;
      if (!this.#stopping) this.#transition('disconnected', 'RUNTIME_STOPPED');
    };
    child.once('close', close);
    // Parent exit withdraws auth immediately. Only the tree ownership probe
    // can confirm that session files are no longer in use by descendants.
    child.once('exit', close);
  }

  #request(method, params) {
    const child = this.#child;
    if (!child || this.#pending.size >= 32) return Promise.reject(failure('RUNTIME_FAILED'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(failure('RUNTIME_TIMEOUT')); }, this.#requestTimeout);
      this.#pending.set(id, { method, attemptId: params.attemptId, resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
          if (!error) return;
          const pending = this.#pending.get(id); if (!pending) return;
          this.#pending.delete(id); clearTimeout(timer); reject(failure('RUNTIME_FAILED'));
        });
      } catch { this.#pending.delete(id); clearTimeout(timer); reject(failure('RUNTIME_FAILED')); }
    });
  }

  #frame(raw, child) {
    if (child !== this.#child || !raw.startsWith(PREFIX)) return;
    let message; try { message = JSON.parse(raw.slice(PREFIX.length)); } catch { return; }
    if (!object(message)) return;
    if (typeof message.id === 'string') {
      const pending = this.#pending.get(message.id); if (!pending) return;
      const hasError = Object.hasOwn(message, 'error');
      if (message.result?.attemptId !== pending.attemptId && !hasError) return;
      const responseError = hasError ? (object(message.error) && typeof message.error.code === 'string' ? failure(message.error.code) : failure('IPC_PROTOCOL')) : null;
      this.#pending.delete(message.id); clearTimeout(pending.timer);
      if (hasError) pending.reject(responseError);
      else if (!object(message.result)) pending.reject(failure('IPC_PROTOCOL'));
      else pending.resolve(message.result);
      return;
    }
    const data = message.data;
    if (!object(data) || !this.#attempt || data.attemptId !== this.#attempt || this.#unquiescent || this.#stopping) return;
    if (message.event === 'qr') this.#acceptQR(data);
    else if (message.event === 'connected') this.#acceptIdentity(data);
    else if (message.event === 'state') {
      if (this.#state === 'connected' && !['disconnected', 'error'].includes(data.status)) return;
      if (['qr_pending', 'awaiting_confirmation', 'verifying'].includes(data.status)) this.#transition(data.status);
      else if (data.status === 'expired') { this.#clearQR(); this.#transition('expired'); }
      else if (data.status === 'error') this.#fail('RUNTIME_FAILED');
      else if (data.status === 'disconnected') { this.#revoke('RUNTIME_STOPPED'); this.#actualSelfId = null; this.#transition('disconnected'); }
    }
    // Message execution and receipts remain owned by the existing QQChannel.
    // This auth-only foundation cannot turn uncorrelated worker events into
    // conversation events or completed-command facts.
  }

  #applyResult(result, attemptId) {
    if (this.#attempt !== attemptId) return;
    if (result.selfId !== undefined) this.#acceptIdentity(result);
    else if (result.dataUrl !== undefined) this.#acceptQR(result);
  }
  #acceptQR(data) {
    if (this.#state === 'connected') return;
    if (!bounded(data.dataUrl, Math.min(this.#maxFrameBytes - 256, 384 * 1024)) || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.dataUrl) || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= this.#now() || data.expiresAt > this.#now() + 10 * 60 * 1000) return;
    this.#clearQR(); this.#qr = { dataUrl: data.dataUrl, expiresAt: data.expiresAt };
    const attemptId = this.#attempt;
    this.#qrTimer = setTimeout(() => { if (this.#attempt === attemptId) { this.#expireQR(); this.#notify(); } }, Math.max(1, data.expiresAt - this.#now()));
    this.#qrTimer.unref?.(); this.#transition('qr_pending');
  }
  #acceptIdentity(data) {
    if (!safeId(data.selfId)) return;
    this.#clearQR();
    if (this.#expectedSelfId && data.selfId !== this.#expectedSelfId) { this.#fail('ACCOUNT_MISMATCH'); return; }
    this.#actualSelfId = data.selfId; this.#transition('connected');
  }

  #releaseStoppedTree(child) {
    if (this.#child !== child) return true;
    let stopped = false; try { stopped = this.#treeStopped?.() === true; } catch {}
    if (!stopped) return false;
    this.#child = null; this.#killTree = null; this.#treeStopped = null; this.#unquiescent = false;
    return true;
  }
  async #waitStopped(child, duration) {
    const deadline = Date.now() + duration;
    do {
      if (this.#releaseStoppedTree(child)) return true;
      await delay(Math.max(1, Math.min(10, deadline - Date.now())));
    } while (Date.now() < deadline);
    return this.#releaseStoppedTree(child);
  }
  async #stopOwned() {
    this.#transition('stopping');
    if (this.#starting && !this.#child) {
      try { await Promise.race([this.#starting, delay(this.#stopTimeout)]); } catch {}
      if (this.#starting && !this.#child) { this.#unquiescent = true; this.#transition('error', 'RUNTIME_NOT_QUIESCENT'); return this.status(); }
    }
    const child = this.#child;
    if (child) {
      if (!this.#parentExited) { try { await Promise.race([this.#request('stop', {}), delay(this.#stopTimeout)]); } catch {} }
      if (!(await this.#waitStopped(child, this.#stopTimeout))) {
        try { this.#killTree?.('SIGTERM'); } catch {}
        if (!(await this.#waitStopped(child, this.#stopTimeout))) {
          try { this.#killTree?.('SIGKILL'); } catch {}
          await this.#waitStopped(child, this.#stopTimeout);
        }
      }
      // A successful RPC is not proof that the owned process exited.
      if (this.#child === child) { this.#unquiescent = true; this.#transition('error', 'RUNTIME_NOT_QUIESCENT'); return this.status(); }
    }
    this.#unquiescent = false; this.#transition('stopped');
    return this.status();
  }
}
