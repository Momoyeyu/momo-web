import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

const PREFIX = 'MOMO_QQ_IPC ';
const safeId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const bounded = (value, maximum = 4096) => typeof value === 'string' && value.length <= maximum && !value.includes('\0');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const workerDiagnosticPhases = new Set([
  'prepare', 'transport_connect', 'transport_connected', 'cached_list_begin', 'cached_list_end',
  'cached_login_begin', 'cached_login_end', 'qr_request', 'qr_received', 'qr_scanned',
  'qr_authenticated', 'session_init', 'session_configured', 'startup_started', 'session_ready', 'telemetry_ready', 'msf_status', 'msf_notification', 'msf_snapshot',
  'identity_begin', 'identity_end', 'native_failure', 'login_failure', 'qr_failure', 'cached_login_failure',
  'inbound_batch', 'inbound_rejected', 'inbound_accepted', 'outbound_update',
]);
const diagnosticPhases = new Set([...workerDiagnosticPhases, 'resource_begin', 'resource_ready', 'process_started', 'process_exit', 'request_timeout']);
const diagnosticFields = new Set(['attemptId', 'phase', 'elapsedMs', 'code']);
const diagnosticLimit = 64;

/** An internal timing record deliberately has no slot for native text or data. */
export function sanitizeQQDiagnostic(value) {
  if (!object(value) || Object.keys(value).some(key => !diagnosticFields.has(key))) return null;
  const { attemptId, phase, elapsedMs } = value;
  if (typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId) || !diagnosticPhases.has(phase) || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 86400000) return null;
  if (Object.hasOwn(value, 'code') && !Number.isSafeInteger(value.code)) return null;
  return Object.freeze({ attemptId, phase, elapsedMs, ...(Object.hasOwn(value, 'code') ? { code: value.code } : {}) });
}
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
  #createTransport; #prepareInvocation; #forgetSession; #onState; #onDiagnostic; #now;
  #requestTimeout; #stopTimeout; #phaseTimeout; #maxFrameBytes;
  #child = null; #starting = null; #stopping = null; #forgetting = false;
  #state = 'idle'; #error = null; #attempt = null; #expectedSelfId = null; #actualSelfId = null; #qr = null; #qrTimer = null;
  #pending = new Map(); #generation = 0; #loginRevision = 0; #unquiescent = false; #cancelStart = false;
  #killTree = null; #treeStopped = null; #parentExited = false;
  #nativeObservers = new Set(); #channelEchoes = new Map();
  #phaseTimer = null; #phaseStatus = null; #phaseAttempt = null;
  #diagnosticCount = 0; #attemptStartedAt = 0;
  #nativeAuthenticated = false;
  #requireFreshLogin = false;
  #loginIntent = null; #retryTimer = null; #intentTimer = null; #retryDelay; #loginIntentTimeout;

  constructor({ createTransport, prepareInvocation, forgetSession, onState = () => {}, onDiagnostic = () => {}, now = Date.now, requestTimeoutMs = 10000, stopTimeoutMs = 1000, phaseTimeoutMs = 30000, maxFrameBytes = 512 * 1024, autoRetryDelayMs = 1000, loginIntentTimeoutMs = 300000 } = {}) {
    this.#createTransport = createTransport;
    this.#prepareInvocation = prepareInvocation;
    this.#forgetSession = forgetSession;
    this.#onState = onState; this.#onDiagnostic = onDiagnostic; this.#now = now;
    this.#requestTimeout = Math.max(10, Math.min(Number(requestTimeoutMs) || 10000, 30000));
    this.#stopTimeout = Math.max(10, Math.min(Number(stopTimeoutMs) || 1000, 5000));
    this.#phaseTimeout = Math.max(10, Math.min(Number(phaseTimeoutMs) || 30000, 90000));
    this.#maxFrameBytes = Math.max(1024, Math.min(Number(maxFrameBytes) || 512 * 1024, 1024 * 1024));
    this.#retryDelay = Math.max(10, Math.min(Number(autoRetryDelayMs) || 1000, 10000));
    this.#loginIntentTimeout = Math.max(1000, Math.min(Number(loginIntentTimeoutMs) || 300000, 600000));
  }

  status({ authenticatedDetail = false, restoreDetail = false } = {}) {
    this.#expireQR();
    const state = { provider: 'qq', status: this.#state, running: this.#child !== null, connected: this.#state === 'connected', actualSelfId: this.#actualSelfId, attemptId: this.#attempt, error: this.#error, executorQuiescent: this.#child === null && this.#starting === null };
    // The authenticated API explicitly opts in after authorizing the caller.
    if (authenticatedDetail === true) state.qr = this.#qr ? { ...this.#qr } : null;
    // Only the trusted coordinator requests the compare-and-swap snapshot.
    if (restoreDetail === true) state.loginRevision = this.#loginRevision;
    return state;
  }

  onNativeEvent(callback) {
    if (typeof callback !== 'function') throw failure('INPUT');
    this.#nativeObservers.add(callback);
    return () => this.#nativeObservers.delete(callback);
  }

  channelQuiescent() { return ![...this.#channelEchoes.values()].some(entry => entry.action === 'send_private_msg'); }

  async requestChannel(action, params, echo) {
    let submitted = false;
    try {
      if (this.#state !== 'connected' || !this.#actualSelfId || !this.#attempt || !this.#child || this.#parentExited || this.#unquiescent || this.#stopping) throw failure('RUNTIME_STOPPED');
      if (!bounded(echo, 200) || !echo || this.#channelEchoes.has(echo) || this.#channelEchoes.size >= 1024 || !object(params)) throw failure('INPUT');
      let arguments_;
      if (action === 'get_login_info') arguments_ = {};
      else if (action === 'send_private_msg' && safeId(params.user_id) && params.user_id !== this.#actualSelfId && bounded(params.message, 32000) && params.message.trim()) arguments_ = { user_id: params.user_id, message: params.message };
      else throw failure('INPUT');
      this.#channelEchoes.set(echo, { action, selfId: this.#actualSelfId, generation: this.#generation });
      try {
        // This is only a control acceptance. The channel adapter independently
        // waits for the matching native OneBot delivery response below.
        return await this.#request('onebot', { attemptId: this.#attempt, action, params: arguments_, echo }, () => { submitted = action === 'send_private_msg'; });
      } catch (cause) { if (!submitted) this.#channelEchoes.delete(echo); throw cause; }
    } catch (cause) { throw Object.assign(sanitizedError(cause), { submitted }); }
  }

  #onebot(data) {
    if (!object(data)) return;
    if (typeof data.echo === 'string') {
      const pending = this.#channelEchoes.get(data.echo);
      if (!pending || pending.generation !== this.#generation || !['ok', 'failed'].includes(data.status) || !Number.isInteger(data.retcode) || !object(data.data)) return;
      if (pending.action === 'get_login_info' && data.status === 'ok' && String(data.data.user_id ?? '') !== pending.selfId) return;
      this.#channelEchoes.delete(data.echo);
    } else if (data.post_type !== 'message' || this.#state !== 'connected' || !this.#actualSelfId || String(data.self_id ?? '') !== this.#actualSelfId) return;
    // Original operation correlation survives cancellation/disconnection while
    // its owned child remains alive. New inbound messages require live auth.
    for (const observer of this.#nativeObservers) { try { observer(structuredClone(data)); } catch {} }
  }

  async begin({ ownerAction = false, expectedSelfId } = {}) {
    return this.#begin({ ownerAction, expectedSelfId }, true, true);
  }

  async restore({ ownerAction = false, expectedSelfId, expectedAttemptId, expectedLoginRevision } = {}) {
    this.#owner(ownerAction);
    const validAttempt = expectedAttemptId === null || (typeof expectedAttemptId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(expectedAttemptId));
    if (!safeId(expectedSelfId) || !validAttempt || !Number.isSafeInteger(expectedLoginRevision) || expectedLoginRevision < 0) throw failure('INPUT');
    // Check both fields before #begin can revoke anything. A stop/cancel while
    // idle still changes the revision even though the attempt remains null.
    if (expectedAttemptId !== this.#attempt || expectedLoginRevision !== this.#loginRevision) throw failure('ATTEMPT_CANCELLED');
    if (this.#unquiescent || this.#starting || this.#stopping || this.#forgetting || this.#loginIntent) throw failure('RUNTIME_NOT_QUIESCENT');
    if (this.#state === 'connected') {
      if (expectedSelfId !== this.#actualSelfId) throw failure('ACCOUNT_MISMATCH');
      return this.status({ restoreDetail: true });
    }
    // Background restoration never tears down an owner-controlled process.
    if (this.#child || ['preparing', 'connecting', 'qr_pending', 'awaiting_confirmation', 'verifying'].includes(this.#state)) throw failure('RUNTIME_NOT_QUIESCENT');
    // #begin reserves the next revision synchronously, before its first await.
    const revision = expectedLoginRevision + 1;
    const result = await this.#begin({ ownerAction, expectedSelfId }, true);
    if (revision !== this.#loginRevision) throw failure('ATTEMPT_CANCELLED');
    return { ...result, loginRevision: revision };
  }

  async #begin({ ownerAction, expectedSelfId }, restoreSession, explicitLogin = false) {
    this.#owner(ownerAction);
    if (expectedSelfId !== undefined && expectedSelfId !== null && !safeId(expectedSelfId)) throw failure('INPUT');
    if (this.#state === 'connected') {
      if (expectedSelfId && expectedSelfId !== this.#actualSelfId) throw failure('ACCOUNT_MISMATCH');
      return this.status();
    }
    if (this.#unquiescent || this.#forgetting) throw failure('RUNTIME_NOT_QUIESCENT');
    if (explicitLogin) {
      this.#clearLoginIntent();
      const intent = { deadline: this.#now() + this.#loginIntentTimeout, qrRenewals: 0, retries: 0 };
      this.#loginIntent = intent;
      this.#intentTimer = setTimeout(() => { if (this.#loginIntent === intent) this.#endLoginIntent('qr'); }, this.#loginIntentTimeout);
      this.#intentTimer.unref?.();
    }
    const revision = ++this.#loginRevision;
    this.#revoke('ATTEMPT_CANCELLED');
    // The native SDK's callbacks have no request ID. A worker therefore owns
    // exactly one login attempt, and must be fully reaped before replacement.
    if (this.#stopping) await this.#stopping;
    else if (this.#child || this.#starting) await this.#stopRuntime();
    if (revision !== this.#loginRevision) throw failure('ATTEMPT_CANCELLED');
    if (this.#unquiescent || this.#child || this.#starting || this.#forgetting) throw failure('RUNTIME_NOT_QUIESCENT');
    if (expectedSelfId !== undefined) this.#expectedSelfId = expectedSelfId;
    const attemptId = randomUUID(); this.#attempt = attemptId; this.#actualSelfId = null; this.#nativeAuthenticated = false;
    this.#diagnosticCount = 0; this.#attemptStartedAt = this.#now();
    this.#transition('preparing');
    try {
      await this.#ensureStarted(); this.#assertAttempt(attemptId);
      await this.#request('prepare', { attemptId, expectedSelfId: this.#expectedSelfId, restoreSession: restoreSession && !this.#requireFreshLogin }); this.#assertAttempt(attemptId);
      this.#transition('connecting');
      this.#applyResult(await this.#request('connect', { attemptId }), attemptId); this.#assertAttempt(attemptId);
      if (this.#state !== 'connected') {
        if (this.#state === 'connecting') this.#transition('qr_pending');
        this.#applyResult(await this.#request('requestQr', { attemptId }), attemptId); this.#assertAttempt(attemptId);
      }
      return this.status();
    } catch (cause) {
      const error = sanitizedError(cause);
      if (this.#attempt === attemptId) this.#fail(error.code);
      throw error;
    }
  }

  async refreshQR({ ownerAction = false } = {}) { return this.#begin({ ownerAction, expectedSelfId: this.#expectedSelfId }, false, true); }

  async cancel() {
    this.#clearLoginIntent();
    this.#loginRevision++;
    const attemptId = this.#attempt;
    this.#revoke('ATTEMPT_CANCELLED'); this.#actualSelfId = null; this.#transition('cancelled');
    if (attemptId && this.#child && !this.#stopping) {
      try { await this.#request('cancel', { attemptId }); }
      catch (cause) { if (!this.#attempt) this.#fail(sanitizedError(cause).code); }
    }
    return this.status();
  }

  async stop() {
    this.#clearLoginIntent();
    this.#loginRevision++;
    return this.#stopRuntime();
  }

  async #stopRuntime() {
    this.#cancelStart = true; this.#revoke('RUNTIME_STOPPED'); this.#actualSelfId = null;
    if (this.#stopping) return this.#stopping;
    const stopping = this.#stopOwned(); this.#stopping = stopping;
    try { return await stopping; }
    finally { if (this.#stopping === stopping) this.#stopping = null; }
  }

  async forget({ ownerAction = false } = {}) {
    this.#owner(ownerAction);
    if (this.#forgetting) throw failure('RUNTIME_NOT_QUIESCENT');
    this.#requireFreshLogin = true;
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
  #clearLoginIntent() {
    clearTimeout(this.#retryTimer); clearTimeout(this.#intentTimer);
    this.#retryTimer = null; this.#intentTimer = null; this.#loginIntent = null;
  }
  #endLoginIntent(kind) {
    this.#clearLoginIntent();
    const revision = ++this.#loginRevision;
    void this.#stopRuntime().then(result => {
      if (this.#loginRevision === revision && !this.#attempt && result.executorQuiescent) this.#transition(kind === 'qr' ? 'expired' : 'error', kind === 'qr' ? null : 'RUNTIME_TIMEOUT');
    });
  }
  #recoverLogin(kind) {
    const intent = this.#loginIntent;
    if (!intent || this.#state === 'connected' || this.#forgetting) return;
    if (this.#retryTimer) return;
    const counter = kind === 'qr' ? 'qrRenewals' : 'retries';
    const limit = kind === 'qr' ? 3 : 2;
    if (this.#now() >= intent.deadline || intent[counter] >= limit) { this.#endLoginIntent(kind); return; }
    intent[counter]++;
    const revision = this.#loginRevision, attempt = this.#attempt;
    const backoff = this.#retryDelay * (kind === 'qr' ? 1 : 2 ** (intent.retries - 1));
    const timer = setTimeout(() => {
      if (this.#retryTimer !== timer) return;
      this.#retryTimer = null;
      if (this.#loginIntent !== intent || this.#loginRevision !== revision || this.#attempt !== attempt) return;
      if (this.#now() >= intent.deadline) { this.#endLoginIntent('qr'); return; }
      if (this.#state === 'connected' || this.#forgetting || this.#unquiescent) { this.#clearLoginIntent(); return; }
      // Only this bounded, explicit login may replace its pre-auth worker.
      // #begin reaps the owned process tree before accepting new callbacks.
      void this.#begin({ ownerAction: true, expectedSelfId: this.#expectedSelfId }, kind !== 'qr').catch(() => {});
    }, backoff);
    this.#retryTimer = timer; timer.unref?.();
  }
  #assertAttempt(attemptId) { if (attemptId !== this.#attempt || !this.#child || this.#unquiescent) throw failure('ATTEMPT_CANCELLED'); }
  #transition(status, code = null) {
    this.#state = status; this.#error = code;
    if (status === 'verifying') this.#clearQR();
    this.#watchPhase(); this.#notify();
  }
  #clearPhase() { clearTimeout(this.#phaseTimer); this.#phaseTimer = null; this.#phaseStatus = null; this.#phaseAttempt = null; }
  #watchPhase() {
    const pending = this.#attempt && (this.#state === 'verifying' || (this.#state === 'qr_pending' && !this.#qr));
    if (!pending) { this.#clearPhase(); return; }
    if (this.#phaseTimer && this.#phaseStatus === this.#state && this.#phaseAttempt === this.#attempt) return;
    this.#clearPhase(); const attemptId = this.#attempt;
    this.#phaseStatus = this.#state; this.#phaseAttempt = attemptId;
    this.#phaseTimer = setTimeout(() => {
      if (this.#attempt !== attemptId) return;
      const revision = this.#loginRevision;
      this.#diagnostic('request_timeout', attemptId);
      this.#fail('RUNTIME_TIMEOUT');
      // No business command can have been admitted before authentication.
      // Stop a late background authentication rather than only hiding its QR.
      void this.#stopRuntime().then(result => {
        if (this.#loginRevision === revision && !this.#attempt && result.executorQuiescent) this.#transition('error', 'RUNTIME_TIMEOUT');
      });
    }, this.#phaseTimeout);
    this.#phaseTimer.unref?.();
  }
  #notify() { try { this.#onState(this.status()); } catch { /* Observers cannot alter ownership. */ } }
  #acceptDiagnostic(value) {
    const record = sanitizeQQDiagnostic(value);
    if (!record || record.attemptId !== this.#attempt || this.#unquiescent || this.#stopping || this.#diagnosticCount >= diagnosticLimit) return;
    this.#diagnosticCount++;
    try { Promise.resolve(this.#onDiagnostic(record)).catch(() => {}); }
    catch { /* A diagnostic sink cannot alter authentication or child ownership. */ }
  }
  #diagnostic(phase, attemptId, generation = this.#generation, code) {
    if (generation !== this.#generation || attemptId !== this.#attempt) return;
    this.#acceptDiagnostic({ attemptId, phase, elapsedMs: Math.max(0, Math.min(this.#now() - this.#attemptStartedAt, 86400000)), ...(Number.isSafeInteger(code) ? { code } : {}) });
  }
  #clearQR() { this.#qr = null; clearTimeout(this.#qrTimer); this.#qrTimer = null; }
  #expireQR() {
    if (this.#qr && this.#qr.expiresAt <= this.#now()) {
      this.#revoke('ATTEMPT_CANCELLED');
      if (this.#state !== 'connected') { this.#state = 'expired'; this.#recoverLogin('qr'); }
    }
  }
  #revoke(code) {
    const previous = this.#attempt; this.#attempt = null; this.#nativeAuthenticated = false; this.#clearQR(); this.#clearPhase();
    for (const [id, pending] of this.#pending) if (pending.attemptId === previous && pending.method !== 'stop') { this.#pending.delete(id); clearTimeout(pending.timer); pending.reject(failure(code)); }
  }
  #fail(code) {
    const intent = this.#loginIntent;
    this.#revoke(code); this.#actualSelfId = null; this.#transition(code === 'ACCOUNT_MISMATCH' ? 'identity_mismatch' : 'error', code);
    if (this.#loginIntent !== intent) return;
    if (code === 'RUNTIME_TIMEOUT' || code === 'RUNTIME_STOPPED') this.#recoverLogin('transient');
    else {
      this.#clearLoginIntent();
      if (intent && (this.#child || this.#starting)) {
        const revision = this.#loginRevision;
        const status = code === 'ACCOUNT_MISMATCH' ? 'identity_mismatch' : 'error';
        // A terminal explicit login has no remaining user action that owns its
        // worker. Reap it automatically, retaining the actionable failure while
        // shutdown runs and fencing completion against a newer login or logout.
        setImmediate(() => {
          if (this.#loginRevision !== revision || this.#attempt || this.#loginIntent) return;
          const stopping = this.#stopRuntime();
          this.#transition(status, code);
          void stopping.then(result => {
            if (this.#loginRevision === revision && !this.#attempt && result.executorQuiescent) this.#transition(status, code);
          });
        });
      }
    }
  }

  async #ensureStarted() {
    if (this.#child) return;
    if (this.#starting) return this.#starting;
    const generation = ++this.#generation; this.#cancelStart = false;
    const attemptId = this.#attempt;
    const starting = (async () => {
      let invocation;
      this.#diagnostic('resource_begin', attemptId, generation);
      if (this.#prepareInvocation) {
        try { invocation = await this.#prepareInvocation(); }
        catch (cause) { throw sanitizedError(cause); }
      } else if (!this.#createTransport) throw failure('RESOURCE_UNAVAILABLE');
      if (this.#cancelStart) throw failure('RUNTIME_STOPPED');
      this.#diagnostic('resource_ready', attemptId, generation);
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
      this.#diagnostic('process_started', attemptId, generation);
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
    const close = (code, signal) => {
      if (!current()) return;
      const exitCode = Number.isSafeInteger(code) ? code : ({ SIGABRT: -6, SIGSEGV: -11, SIGILL: -4, SIGTRAP: -5, SIGTERM: -15, SIGKILL: -9 })[signal];
      this.#diagnostic('process_exit', this.#attempt, generation, exitCode);
      this.#parentExited = true; line = Buffer.alloc(0);
      for (const [id, pending] of this.#pending) { this.#pending.delete(id); clearTimeout(pending.timer); pending.reject(failure('RUNTIME_STOPPED')); }
      this.#revoke('RUNTIME_STOPPED'); this.#actualSelfId = null;
      if (!this.#releaseStoppedTree(child)) this.#unquiescent = true;
      if (!this.#stopping) { this.#clearLoginIntent(); this.#transition('disconnected', 'RUNTIME_STOPPED'); }
    };
    child.once('close', close);
    // Parent exit withdraws auth immediately. Only the tree ownership probe
    // can confirm that session files are no longer in use by descendants.
    child.once('exit', close);
  }

  #request(method, params, onDispatch = () => {}) {
    const child = this.#child;
    if (!child || this.#pending.size >= 32) return Promise.reject(failure('RUNTIME_FAILED'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#diagnostic('request_timeout', params.attemptId);
        this.#pending.delete(id); reject(failure('RUNTIME_TIMEOUT'));
      }, this.#requestTimeout);
      this.#pending.set(id, { method, attemptId: params.attemptId, resolve, reject, timer });
      try {
        onDispatch();
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
    if (message.event === 'diagnostic') {
      if (workerDiagnosticPhases.has(message.data?.phase)) this.#acceptDiagnostic(message.data);
      return;
    }
    if (message.event === 'onebot') { this.#onebot(message.data); return; }
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
      if (data.status === 'verifying' && data.authenticated === true) this.#nativeAuthenticated = true;
      // Cached recovery may explicitly fall back to QR. Only genuine native
      // authentication makes verification monotonic for this owned attempt.
      if (this.#nativeAuthenticated && this.#state === 'verifying' && ['qr_pending', 'awaiting_confirmation'].includes(data.status)) return;
      if (['qr_pending', 'awaiting_confirmation', 'verifying'].includes(data.status)) this.#transition(data.status);
      else if (data.status === 'expired') {
        const intent = this.#loginIntent, revision = this.#loginRevision;
        this.#revoke('ATTEMPT_CANCELLED'); this.#transition('expired');
        if (this.#loginIntent === intent && this.#loginRevision === revision) this.#recoverLogin('qr');
      }
      else if (data.status === 'error') this.#fail(knownErrorCode(data.code));
      else if (data.status === 'disconnected') {
        const intent = this.#loginIntent, revision = this.#loginRevision;
        this.#revoke('RUNTIME_STOPPED'); this.#actualSelfId = null; this.#transition('disconnected');
        if (this.#loginIntent === intent && this.#loginRevision === revision) this.#recoverLogin('transient');
      }
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
    if (this.#state === 'connected' || this.#state === 'verifying') return;
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
    this.#clearLoginIntent();
    this.#requireFreshLogin = false;
    this.#actualSelfId = data.selfId; this.#transition('connected');
  }

  #releaseStoppedTree(child) {
    if (this.#child !== child) return true;
    let stopped = false; try { stopped = this.#treeStopped?.() === true; } catch {}
    if (!stopped) return false;
    this.#child = null; this.#killTree = null; this.#treeStopped = null; this.#unquiescent = false;
    this.#channelEchoes.clear();
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
