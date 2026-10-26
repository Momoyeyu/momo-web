import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ChannelError extends Error {
  constructor(code, message, submitted = false) { super(message); this.code = code; this.submitted = submitted; }
}
const error = (code, message, submitted = false) => new ChannelError(code, message, submitted);
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const capabilities = Object.freeze({ receive: true, reply: true, proactive: false, contacts: false, history: false, groups: false });
const disabledCapabilities = Object.freeze(Object.fromEntries(Object.keys(capabilities).map(key => [key, false])));

export class ChannelCursorStore {
  constructor(path) { this.path = path; this.writes = Promise.resolve(); }
  key(config) { return createHash('sha256').update(JSON.stringify([config.accountId, config.expectedSelfId, config.endpoint])).digest('hex'); }
  async load(config) {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      if (state.version !== 1 || !state.cursors || typeof state.cursors !== 'object') throw Error('invalid cursor state');
      const cursor = state.cursors[this.key(config)];
      if (cursor === undefined) return '';
      if (!/^\d{1,20}$/.test(cursor)) throw Error('invalid cursor');
      return cursor;
    } catch (cause) {
      if (cause?.code === 'ENOENT') return '';
      throw error('CURSOR_STATE', 'Private channel cursor state is unavailable');
    }
  }
  async save(config, cursor) {
    if (!/^\d{1,20}$/.test(cursor)) throw error('BRIDGE_PROTOCOL', 'WeChat cursor is invalid');
    const write = async () => {
      let state = { version: 1, cursors: {} };
      try { state = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (cause) { if (cause?.code !== 'ENOENT') throw cause; }
      if (state.version !== 1 || !state.cursors || typeof state.cursors !== 'object') throw Error('invalid cursor state');
      state.cursors[this.key(config)] = cursor;
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); await rename(temporary, this.path); }
      finally { await rm(temporary, { force: true }); }
    };
    const pending = this.writes.then(write);
    this.writes = pending.catch(() => {});
    try { await pending; } catch { throw error('CURSOR_STATE', 'Private channel cursor state could not be saved'); }
  }
}

function endpoint(config, protocols) {
  let url;
  try { url = new URL(config.endpoint); } catch { throw error('CONFIG', 'Configure a valid channel bridge address'); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash || url.search) throw error('CONFIG', 'Unsupported channel bridge address');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!loopback && !['https:', 'wss:'].includes(url.protocol)) throw error('CONFIG', 'A remote bridge requires an encrypted connection');
  if (!opaque(config.accountId) || !opaque(config.expectedSelfId) || !Number.isSafeInteger(config.policyRevision) || config.policyRevision < 0) throw error('CONFIG', 'Configure the channel account identity and policy revision');
  if (typeof config.credential?.token !== 'string' || !config.credential.token || config.credential.token.length > 4096) throw error('CONFIG', 'Channel bridge credential is required');
  if (config.allowlistEnabled && (!Array.isArray(config.allowlist) || config.allowlist.some(id => !opaque(id)))) throw error('CONFIG', 'Invalid contact allowlist');
  return url;
}

/** Built-in adapters expose only private text events and fixed-recipient sends. */
export class PersonalChannel {
  constructor(config, { onInbox, onState = () => {}, onLateReceipt = () => {}, active = () => true, now = Date.now, cursorStore } = {}) {
    this.config = config;
    this.onInbox = onInbox;
    this.onState = onState;
    this.onLateReceipt = onLateReceipt;
    this.active = active;
    this.now = now;
    this.cursorStore = cursorStore;
    this.pendingInbox = new Map();
    this.status = 'connecting';
    this.actualSelfId = null;
    this.closed = false;
    this.quarantined = false;
    this.activeSends = 0;
    this.remoteQuiescent = true;
    this.lastError = null;
    this.retryTimer = setInterval(() => { for (const message of this.pendingInbox.values()) if (this.allowed(message.peerId, 'receive')) this.onInbox(message); }, 2000);
    this.retryTimer.unref();
  }
  state(status, code = null) { this.status = status; this.lastError = code; this.onState(this.health()); }
  health() { return { pluginId: this.config.id, accountId: this.config.accountId, actualSelfId: this.actualSelfId, status: this.quarantined ? 'paused' : this.closed ? 'disconnected' : this.status, error: this.lastError, identityKind: 'personal', capabilities: !this.closed && this.status === 'connected' ? { ...capabilities, ...(this.remoteCapabilities ?? {}) } : disabledCapabilities, executorQuiescent: this.activeSends === 0 && this.remoteQuiescent === true }; }
  allowed(peerId, action) { return this.active() && !this.closed && !this.quarantined && this.config.permissions?.[action] === true && (!this.config.allowlistEnabled || this.config.allowlist.includes(peerId)); }
  check(peerId, action) {
    if (!opaque(peerId) || peerId === this.actualSelfId) throw error('INPUT', 'A verified private conversation is required');
    if (this.closed || this.quarantined || !this.active() || this.status !== 'connected') throw error('PLUGIN_UNAVAILABLE', 'Channel account is not connected');
    if (this.remoteCapabilities?.[action] === false) throw error('CAPABILITY_UNAVAILABLE', 'This channel authorization does not support the requested operation');
    if (!this.allowed(peerId, action)) throw error('FORBIDDEN', 'Channel permission or contact scope does not allow this action');
  }
  receive(message) {
    if (!opaque(message.externalMessageId) || !opaque(message.peerId) || !opaque(message.senderId) || message.senderId !== message.peerId || message.selfId !== this.actualSelfId || message.conversationKind !== 'private' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 32000 || !this.allowed(message.peerId, 'receive')) return;
    const inboxId = message.externalMessageId;
    if (this.pendingInbox.has(inboxId)) return;
    if (this.pendingInbox.size >= 4096) { this.state('attention_required', 'INBOX_CAPACITY'); return; }
    const event = { ...message, pluginId: this.config.id, source: this.config.type, accountId: this.config.accountId, policyRevision: this.config.policyRevision, inboxId, receivedAt: this.now() };
    this.pendingInbox.set(inboxId, event);
    this.onInbox(event);
  }
  ack(inboxId) { return { acknowledged: this.pendingInbox.delete(inboxId) }; }
  quarantine() { this.quarantined = true; this.state('paused', 'OUTCOME_UNKNOWN'); }
  async close() { this.closed = true; clearInterval(this.retryTimer); this.pendingInbox.clear(); this.state('disconnected'); }
}

export class QQChannel extends PersonalChannel {
  async connect() {
    const url = endpoint(this.config, ['ws:', 'wss:']);
    url.searchParams.set('access_token', this.config.credential.token);
    this.rpcPending = new Map();
    this.socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.socket.close(); reject(error('CONNECT_TIMEOUT', 'QQ bridge connection timed out')); }, Math.max(100, Math.min(Number(this.config.connectTimeoutMs) || 5000, 15000)));
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timeout); reject(error('CONNECT_FAILED', 'QQ bridge is unavailable')); }, { once: true });
      this.socket.addEventListener('close', () => {
        clearTimeout(timeout); reject(error('CONNECT_FAILED', 'QQ bridge disconnected'));
        for (const entry of this.rpcPending.values()) { clearTimeout(entry.timer); entry.reject?.(error('OUTCOME_UNKNOWN', 'QQ bridge disconnected before confirmation', entry.submitted)); }
        this.rpcPending.clear();
        if (!this.closed) this.state('disconnected', 'BRIDGE_DISCONNECTED');
      });
      this.socket.addEventListener('message', event => this.message(event.data));
    });
    const identity = await this.rpc('get_login_info', {});
    this.assertIdentity(identity.user_id);
    this.state('connected');
  }
  assertIdentity(value) {
    if (String(value ?? '') !== this.config.expectedSelfId) { this.state('identity_mismatch', 'ACCOUNT_MISMATCH'); throw error('ACCOUNT_MISMATCH', 'The logged-in QQ account does not match the configured account'); }
    this.actualSelfId = String(value);
  }
  rpc(action, params, { signal, commandId, beforeDispatch = () => {} } = {}) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(error('PLUGIN_UNAVAILABLE', 'QQ bridge is disconnected'));
    return new Promise((resolve, reject) => {
      const echo = randomUUID(), submitted = action === 'send_private_msg';
      const entry = { resolve, reject, submitted, commandId, timer: null, abort: null, expired: false };
      const expire = code => {
        if (entry.expired) return;
        entry.expired = true; entry.resolve = null; entry.reject = null;
        signal?.removeEventListener('abort', entry.abort);
        // Keep correlation for late provider facts, never repeat a submitted send.
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.rpcPending.delete(echo), 60000); entry.timer.unref();
        reject(error(submitted ? 'OUTCOME_UNKNOWN' : code, submitted ? 'QQ send outcome is unknown' : 'QQ bridge query did not finish', submitted));
      };
      entry.timer = setTimeout(() => expire('TIMEOUT'), Math.max(50, Math.min(Number(this.config.timeoutMs) || 10000, 30000)));
      entry.abort = () => expire('CANCELLED');
      if (signal?.aborted) { clearTimeout(entry.timer); reject(error('CANCELLED', 'QQ request was stopped')); return; }
      signal?.addEventListener('abort', entry.abort, { once: true });
      entry.cleanup = () => signal?.removeEventListener('abort', entry.abort);
      this.rpcPending.set(echo, entry);
      try { beforeDispatch(); this.socket.send(JSON.stringify({ action, params, echo })); }
      catch (cause) { clearTimeout(entry.timer); entry.cleanup(); this.rpcPending.delete(echo); reject(cause instanceof ChannelError ? cause : error('DISPATCH_FAILED', 'QQ bridge dispatch failed')); }
    });
  }
  message(raw) {
    if (typeof raw !== 'string' || raw.length > 1024 * 1024) return;
    let event; try { event = JSON.parse(raw); } catch { return; }
    if (event.echo) {
      const entry = this.rpcPending.get(event.echo); if (!entry) return;
      this.rpcPending.delete(event.echo); clearTimeout(entry.timer); entry.cleanup?.();
      const success = event.status === 'ok' && event.retcode === 0;
      if (entry.expired) { if (entry.submitted) this.onLateReceipt({ commandId: entry.commandId, status: success ? 'completed' : 'failed', deliveryStatus: success ? 'provider_accepted' : 'provider_rejected', externalMessageId: success ? String(event.data?.message_id ?? '') : undefined }); }
      else if (success) entry.resolve(event.data ?? {});
      else entry.reject(error('PROVIDER_REJECTED', 'QQ bridge rejected the operation'));
      return;
    }
    if (event.post_type !== 'message' || event.message_type !== 'private' || (event.sub_type !== undefined && event.sub_type !== 'friend') || String(event.self_id) !== this.actualSelfId || String(event.user_id) === this.actualSelfId) return;
    const id = event.real_seq ?? event.message_seq ?? event.message_id;
    if (!['string', 'number'].includes(typeof id) || !Number.isFinite(Number(event.time))) return;
    const parts = Array.isArray(event.message) ? event.message : [];
    // Ignore media-only inputs and non-text CQ content; never reinterpret segments as tools.
    const text = parts.filter(item => item?.type === 'text' && typeof item.data?.text === 'string').map(item => item.data.text).join('');
    const peerId = String(event.user_id);
    this.receive({ selfId: this.actualSelfId, peerId, senderId: peerId, conversationKind: 'private', externalMessageId: `qq:${this.actualSelfId}:${peerId}:${event.time}:${id}`, text });
  }
  async send({ peerId, text, commandId, signal, beforeDispatch }) {
    this.check(peerId, 'reply');
    this.activeSends++;
    try {
      this.assertIdentity((await this.rpc('get_login_info', {}, { signal })).user_id);
      const data = await this.rpc('send_private_msg', { user_id: peerId, message: [{ type: 'text', data: { text } }] }, { signal, commandId, beforeDispatch: () => { this.check(peerId, 'reply'); beforeDispatch(); } });
      return { deliveryStatus: 'provider_accepted', externalMessageId: String(data.message_id ?? '') };
    } finally { this.activeSends--; }
  }
  async stop() { return { executorQuiescent: this.activeSends === 0 }; }
  async close() { await super.close(); for (const entry of this.rpcPending?.values() ?? []) { clearTimeout(entry.timer); entry.cleanup?.(); entry.reject?.(error('OUTCOME_UNKNOWN', 'QQ connection closed before confirmation', entry.submitted)); } this.rpcPending?.clear(); this.socket?.close(); }
}

export class WeChatChannel extends PersonalChannel {
  async connect() {
    this.url = endpoint(this.config, ['http:', 'https:']);
    this.controllers = new Set();
    this.cursor = this.cursorStore ? await this.cursorStore.load(this.config) : '';
    this.pageCursor = null;
    await this.refreshHealth();
    if (this.status !== 'connected') throw error('LOGIN_REQUIRED', 'WeChat bridge requires a verified personal account session');
    if (this.durableAck && this.cursor) await this.http('/v1/ack', { body: { expectedSelfId: this.config.expectedSelfId, cursor: this.cursor } });
    this.pollTimer = setInterval(() => { void this.poll(); }, Math.max(100, Math.min(Number(this.config.pollMs) || 1000, 10000)));
    this.pollTimer.unref();
    void this.poll();
  }
  async http(path, { body, signal, submitted = false, beforeDispatch = () => {} } = {}) {
    const controller = new AbortController(); this.controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, Math.max(50, Math.min(Number(this.config.timeoutMs) || 10000, 30000)));
    try {
      if (controller.signal.aborted) throw error('CANCELLED', 'WeChat request was stopped');
      beforeDispatch();
      const response = await fetch(new URL(path, this.url), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.config.credential.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error' });
      const text = await response.text(); if (text.length > 1024 * 1024) throw error('BRIDGE_PROTOCOL', 'WeChat response exceeds supported size', submitted);
      let result; try { result = JSON.parse(text); } catch { throw error('BRIDGE_PROTOCOL', 'WeChat bridge returned an invalid response', submitted); }
      if (!response.ok) {
        const knownUnsent = [401, 403, 409].includes(response.status) && (response.status === 401 || result.status === 'not_sent');
        if (submitted && !knownUnsent) throw error('OUTCOME_UNKNOWN', 'WeChat gateway failed after submission; verify the original command', true);
        throw error(response.status === 401 ? 'UNAUTHORIZED' : 'PROVIDER_REJECTED', 'WeChat bridge rejected the operation');
      }
      return result;
    } catch (cause) { if (cause instanceof ChannelError) throw cause; throw error(submitted ? 'OUTCOME_UNKNOWN' : 'BRIDGE_UNAVAILABLE', submitted ? 'WeChat send outcome is unknown' : 'WeChat bridge is unavailable', submitted); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }
  async refreshHealth() {
    const health = await this.http('/v1/health');
    if (health.actualSelfId !== this.config.expectedSelfId || health.identityKind !== 'personal' || health.identityVerified !== true) { this.state('identity_mismatch', 'ACCOUNT_MISMATCH'); throw error('ACCOUNT_MISMATCH', 'WeChat personal account identity is not verified'); }
    this.actualSelfId = health.actualSelfId;
    this.durableAck = health.capabilities?.durableAck === true;
    this.executionFence = health.capabilities?.executionFence === true;
    this.executionGeneration = this.executionFence && Number.isSafeInteger(health.executionGeneration) ? health.executionGeneration : null;
    this.remoteQuiescent = this.executionFence && health.executorQuiescent === true;
    this.remoteCapabilities = { ...disabledCapabilities, receive: health.capabilities?.receive === true, reply: health.capabilities?.reply === true };
    this.peers = new Set((Array.isArray(health.peers) ? health.peers : []).filter(peer => peer.verified === true && opaque(peer.peerId)).map(peer => peer.peerId));
    this.state(health.status === 'connected' ? 'connected' : 'login_required');
    return this.health();
  }
  async poll() {
    if (this.closed || this.polling || this.pendingInbox.size || !this.active() || this.status !== 'connected' || !this.config.permissions?.receive || this.remoteCapabilities?.receive !== true) return;
    this.polling = true;
    try {
      const data = await this.http(`/v1/inbox?cursor=${encodeURIComponent(this.cursor)}`);
      if (!Array.isArray(data.events) || data.events.length > 100 || typeof data.cursor !== 'string' || data.cursor.length > 200) throw error('BRIDGE_PROTOCOL', 'WeChat inbox response is invalid');
      for (const item of data.events) { if (this.peers.has(item.peerId)) this.receive(item); }
      this.pageCursor = data.cursor;
      if (!this.pendingInbox.size) await this.commitPage();
    } catch (cause) { if (!this.closed) this.lastError = cause instanceof ChannelError ? cause.code : 'BRIDGE_UNAVAILABLE'; }
    finally { this.polling = false; }
  }
  async ack(inboxId) {
    const result = super.ack(inboxId);
    if (!this.pendingInbox.size) await this.commitPage();
    return result;
  }
  async commitPage() {
    if (this.pageCursor === null || this.pageCursor === this.cursor) return;
    if (this.cursorStore) await this.cursorStore.save(this.config, this.pageCursor);
    this.cursor = this.pageCursor;
    if (this.durableAck) await this.http('/v1/ack', { body: { expectedSelfId: this.config.expectedSelfId, cursor: this.pageCursor } });
  }
  async send({ peerId, text, commandId, signal, beforeDispatch }) {
    this.check(peerId, 'reply');
    await this.refreshHealth();
    if (this.executionFence && this.executionGeneration === null) throw error('BRIDGE_PAUSED', 'WeChat bridge requires a fresh execution grant');
    if (!this.peers.has(peerId)) throw error('PEER_UNVERIFIED', 'WeChat recipient must have a verified unique binding');
    this.activeSends++; this.remoteQuiescent = false;
    try {
      const result = await this.http('/v1/send', { body: { commandId, expectedSelfId: this.config.expectedSelfId, peerId, text, ...(this.executionFence ? { executionGeneration: this.executionGeneration } : {}) }, signal, submitted: true, beforeDispatch: () => { this.check(peerId, 'reply'); beforeDispatch(); } });
      if (result.commandId !== commandId || result.peerId !== peerId || result.actualSelfId !== this.actualSelfId || result.executorQuiescent !== true || !['client_observed', 'provider_accepted', 'provider_rejected'].includes(result.status)) throw error('OUTCOME_UNKNOWN', 'WeChat send confirmation does not match the original command', true);
      this.remoteQuiescent = this.executionFence;
      if (result.status === 'provider_rejected') throw error('PROVIDER_REJECTED', 'WeChat bridge rejected the operation');
      return { deliveryStatus: result.status, ...(opaque(result.externalMessageId) ? { externalMessageId: result.externalMessageId } : {}) };
    } finally { this.activeSends--; }
  }
  async stop() {
    try { const result = await this.http('/v1/stop', { body: { expectedSelfId: this.config.expectedSelfId } }); this.executionGeneration = null; this.remoteQuiescent = this.executionFence && result.executorQuiescent === true; }
    catch { this.remoteQuiescent = false; }
    return { executorQuiescent: this.activeSends === 0 && this.remoteQuiescent };
  }
  async grant() {
    if (!this.executionFence) return;
    const result = await this.http('/v1/grant', { body: { expectedSelfId: this.config.expectedSelfId } });
    if (!Number.isSafeInteger(result.executionGeneration) || result.executorQuiescent !== true) throw error('BRIDGE_PROTOCOL', 'WeChat execution grant is invalid');
    this.executionGeneration = result.executionGeneration;
    this.remoteQuiescent = true;
  }
  async close() { clearInterval(this.pollTimer); for (const controller of this.controllers ?? []) controller.abort(); if (!this.closed && (this.executionFence || !this.remoteQuiescent)) await this.stop(); await super.close(); }
}
