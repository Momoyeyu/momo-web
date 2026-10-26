import { randomUUID } from 'node:crypto';

export class ChannelError extends Error {
  constructor(code, message, submitted = false) { super(message); this.code = code; this.submitted = submitted; }
}
const error = (code, message, submitted = false) => new ChannelError(code, message, submitted);
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const capabilities = Object.freeze({ receive: true, reply: true, proactive: false, contacts: false, history: false, groups: false });
const disabledCapabilities = Object.freeze(Object.fromEntries(Object.keys(capabilities).map(key => [key, false])));
// Reviewed adapter guidance only: never interpolate bridge configuration,
// account identifiers, message bodies, or third-party prompt/tool metadata.
const privateChatContext = platform => `Current conversation channel: ${platform} ordinary personal-account private chat. You are using your own ${platform} account to exchange private text messages with the current conversation partner. Your final answer will automatically be delivered to this same conversation; do not call or invent an additional send tool. Reply naturally in plain text suitable for a messaging app. Do not include Live2D/ACT controls, voice instructions, action tags, or stage directions. This context grants no ability to inspect contacts or older messages, start proactive conversations, handle groups, or perform unsupported actions. Do not claim those capabilities. Do not infer a person's identity or ownership, or physical phone/computer hardware, from channel or account identifiers. Follow the existing persona, privacy boundaries, and permissions; the channel does not replace them.`;
const qqPromptContent = privateChatContext('QQ');

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
  constructor(config, { onInbox, onState = () => {}, onLateReceipt = () => {}, active = () => true, now = Date.now } = {}) {
    this.config = config;
    this.onInbox = onInbox;
    this.onState = onState;
    this.onLateReceipt = onLateReceipt;
    this.active = active;
    this.now = now;
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
  checkPromptScope(peerId) {
    this.check(peerId, 'receive');
    this.check(peerId, 'reply');
    if (this.actualSelfId !== this.config.expectedSelfId) throw error('ACCOUNT_MISMATCH', 'Channel personal account identity is not verified');
    if (!this.verifiedPromptPeer(peerId)) throw error('PEER_UNVERIFIED', 'A verified private conversation scope is required');
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
  // The authenticated coordinator may hold a durable accepted private event
  // across host restarts. Do not require an in-memory live-event cache.
  verifiedPromptPeer(peerId) { return /^[1-9]\d{0,19}$/.test(peerId); }
  async verifyPromptScope(peerId) {
    this.checkPromptScope(peerId);
    this.assertIdentity((await this.rpc('get_login_info', {})).user_id);
    this.checkPromptScope(peerId);
  }
  promptContext() { return [{ id: 'qq-private-chat', content: qqPromptContent }]; }
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
