import { QQ_MUTATIONS, QQ_OPERATIONS, qqGroup, qqOperationParams } from './qq-operations.mjs';
import { randomUUID } from 'node:crypto';

export class ChannelError extends Error {
  constructor(code, message, submitted = false) { super(message); this.code = code; this.submitted = submitted; }
}
const error = (code, message, submitted = false) => new ChannelError(code, message, submitted);
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const capabilities = Object.freeze({ receive: true, reply: true, proactive: true, contacts: true, history: true, media: true, friendRequests: true, groups: true, groupManagement: true });
const disabledCapabilities = Object.freeze(Object.fromEntries(Object.keys(capabilities).map(key => [key, false])));
// Reviewed adapter guidance only: never interpolate connection configuration,
// account identifiers, message bodies, or third-party prompt/tool metadata.
const privateChatContext = platform => `Current conversation channel: ${platform} ordinary personal-account private chat. You are using your own ${platform} account to exchange private text messages with the current conversation partner. Your final answer will automatically be delivered to this same conversation; do not call or invent an additional send tool. Reply naturally in plain text suitable for a messaging app. Do not include Live2D/ACT controls, voice instructions, action tags, or stage directions. Additional QQ tools are available only if explicitly provided for this turn; do not claim unread contacts, history, media or performed actions without successful scoped tool results. Do not infer a person's identity or ownership, or physical phone/computer hardware, from channel or account identifiers. Follow the existing persona, privacy boundaries, and permissions; the channel does not replace them.`;
const qqPromptContent = privateChatContext('QQ');
const qqGroupPromptContent = 'Current conversation channel: QQ ordinary personal-account group chat. You are using your own QQ account to participate in the current group. Your final answer is automatically delivered to this same group; do not call a separate send tool for this reply. Group members share this group conversation only and are not the local owner. Do not reveal the owner’s private memories, other contacts, other groups, or unrelated history. Reply in plain text suitable for a group message; do not include Live2D controls, voice instructions or stage directions. Additional scoped tools are available only when explicitly provided; use successful tool results as evidence and do not invent actions or permissions.';

function accountConfig(config) {
  if (!opaque(config.accountId) || !opaque(config.expectedSelfId) || !Number.isSafeInteger(config.policyRevision) || config.policyRevision < 0) throw error('CONFIG', 'Configure the channel account identity and policy revision');
  if (config.allowlistEnabled && (!Array.isArray(config.allowlist) || config.allowlist.some(id => !opaque(id)))) throw error('CONFIG', 'Invalid contact allowlist');
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
  allowed(peerId, action) {
    const group=qqGroup(peerId);if(group){const ids=(this.config.groupAllowlist??[]).map(value=>typeof value==='string'?value:value?.peerId);if(this.config.permissions?.groups!==true||!ids.some(value=>value===group||value===peerId))return false;return this.active()&&!this.closed&&!this.quarantined&&this.config.permissions?.[action]===true;}
    return this.active() && !this.closed && !this.quarantined && this.config.permissions?.[action] === true && (!this.config.allowlistEnabled || this.config.allowlist.includes(peerId)); }
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
    if (!opaque(message.externalMessageId) || !opaque(message.peerId) || !opaque(message.senderId) || (message.conversationKind==='private'&&message.senderId !== message.peerId) || message.selfId !== this.actualSelfId || !['private','group'].includes(message.conversationKind) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 32000 || !this.allowed(message.peerId, 'receive')) return;
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
  constructor(config, options = {}) {
    super(config, options);
    this.nativeRuntime = options.nativeRuntime;
    this.rpcPending = new Map();
    this.proactiveAdmissions = [];
    this.lastProactiveDispatch = null;
  }
  health() {
    if (this.nativeRuntime) this.remoteQuiescent = this.nativeRuntime.channelQuiescent?.() === true;
    const result = super.health();
    if (this.nativeRuntime && !this.closed) {
      const native = this.nativeRuntime.status();
      if (!native.connected || native.actualSelfId !== this.config.expectedSelfId) return { ...result, status: native.connected ? 'identity_mismatch' : 'disconnected', capabilities: disabledCapabilities };
    }
    return result;
  }
  // The authenticated coordinator may hold a durable accepted private event
  // across host restarts. Do not require an in-memory live-event cache.
  verifiedPromptPeer(peerId) { return /^[1-9]\d{0,19}$/.test(peerId)||!!qqGroup(peerId); }
  async verifyPromptScope(peerId) {
    this.checkPromptScope(peerId);
    this.assertIdentity((await this.rpc('get_login_info', {})).user_id);
    if(qqGroup(peerId)){const result=await this.rpc('groups.list',{scopePeerIds:[peerId],limit:1});if(!result.groups?.some(group=>group.peerId===peerId))throw error('PEER_UNVERIFIED','QQ group membership is no longer verified');}
    this.checkPromptScope(peerId);
  }
  promptContext(peerId) { return [qqGroup(peerId)?{id:'qq-group-chat',content:qqGroupPromptContent}:{ id: 'qq-private-chat', content: qqPromptContent }]; }
  async connect() {
    if (this.config.transport !== 'managed' || ['endpoint', 'credential', 'token'].some(key => Object.hasOwn(this.config, key))) throw error('CONFIG', 'QQ requires the managed native account connection');
    accountConfig(this.config);
    if (typeof this.nativeRuntime?.requestChannel !== 'function' || typeof this.nativeRuntime.onNativeEvent !== 'function' || !this.nativeRuntime.status?.()?.connected) throw error('PLUGIN_UNAVAILABLE', 'Log in to the managed QQ account first');
    this.assertIdentity(this.nativeRuntime.status().actualSelfId);
    this.unsubscribeNative = this.nativeRuntime.onNativeEvent(event => this.message(JSON.stringify(event)));
    this.assertIdentity((await this.rpc('get_login_info', {})).user_id);
    this.state('connected');
  }
  releaseNativeSubscription() {
    if (this.closed && this.rpcPending.size === 0) { this.unsubscribeNative?.(); this.unsubscribeNative = null; }
  }
  assertIdentity(value) {
    if (String(value ?? '') !== this.config.expectedSelfId) { this.state('identity_mismatch', 'ACCOUNT_MISMATCH'); throw error('ACCOUNT_MISMATCH', 'The logged-in QQ account does not match the configured account'); }
    this.actualSelfId = String(value);
  }
  rpc(action, params, { signal, commandId, beforeDispatch = () => {} } = {}) {
    if (this.closed || !this.nativeRuntime?.status?.()?.connected) return Promise.reject(error('PLUGIN_UNAVAILABLE', 'QQ account is disconnected'));
    return new Promise((resolve, reject) => {
      const echo = randomUUID(), submitted = QQ_MUTATIONS.has(action);
      const entry = { resolve, reject, submitted, commandId, timer: null, abort: null, expired: false, wasDispatched: false };
      const expire = code => {
        if (entry.expired) return;
        entry.expired = true; entry.resolve = null; entry.reject = null;
        signal?.removeEventListener('abort', entry.abort);
        // Keep correlation for late provider facts, never repeat a submitted send.
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { this.rpcPending.delete(echo); this.releaseNativeSubscription(); }, 60000); entry.timer.unref();
        reject(error(submitted ? 'OUTCOME_UNKNOWN' : code, submitted ? 'QQ send outcome is unknown' : 'QQ account query did not finish', submitted));
      };
      entry.expire = expire;
      entry.timer = setTimeout(() => expire('TIMEOUT'), Math.max(50, Math.min(Number(this.config.timeoutMs) || 10000, 30000)));
      entry.cancelNative=()=>entry.cancelPromise??=(typeof this.nativeRuntime.cancelChannel==='function'?Promise.resolve(this.nativeRuntime.cancelChannel(echo)):Promise.resolve());
      entry.abort = () => {void entry.cancelNative().catch(()=>{});expire('CANCELLED');};
      if (signal?.aborted) { clearTimeout(entry.timer); reject(error('CANCELLED', 'QQ request was stopped')); return; }
      signal?.addEventListener('abort', entry.abort, { once: true });
      entry.cleanup = () => signal?.removeEventListener('abort', entry.abort);
      this.rpcPending.set(echo, entry);
      const failedDispatch = cause => {
        if (this.rpcPending.get(echo) !== entry || entry.expired) return;
        if (entry.wasDispatched && submitted && cause?.submitted !== false) { expire('OUTCOME_UNKNOWN'); return; }
        clearTimeout(entry.timer); entry.cleanup(); this.rpcPending.delete(echo); this.releaseNativeSubscription();
        reject(cause instanceof ChannelError ? cause : error('DISPATCH_FAILED', 'QQ account dispatch failed'));
      };
      try {
        if(this.nativeRuntime.requiresChannelCommit!==true||!submitted)beforeDispatch();
        const nativeParams = action === 'send_private_msg' ? { user_id: params.user_id, message: params.message.map(part => part.data.text).join('') } : params;
        entry.wasDispatched = true;
        // A control acknowledgement proves only IPC acceptance. The provider
        // response with this echo is the sole source of a send receipt.
        Promise.resolve(this.nativeRuntime.requestChannel(action, nativeParams, echo,{beforeCommit:()=>{if(this.closed||entry.expired||signal?.aborted)throw error('CANCELLED','QQ native preparation was withdrawn');beforeDispatch();}})).catch(failedDispatch);
      } catch (cause) { failedDispatch(cause); }
    });
  }
  message(raw) {
    if (typeof raw !== 'string' || raw.length > 16 * 1024 * 1024) return;
    let event; try { event = JSON.parse(raw); } catch { return; }
    if (event.echo) {
      const entry = this.rpcPending.get(event.echo); if (!entry) return;
      this.rpcPending.delete(event.echo); clearTimeout(entry.timer); entry.cleanup?.();
      this.releaseNativeSubscription();
      const success = event.status === 'ok' && event.retcode === 0;
      if (entry.expired) { if (entry.submitted) this.onLateReceipt({ commandId: entry.commandId, status: success ? 'completed' : 'failed', deliveryStatus: success ? 'provider_accepted' : 'provider_rejected', externalMessageId: success ? String(event.data?.message_id ?? '') : undefined }); }
      else if (success) entry.resolve(event.data ?? {});
      else entry.reject(error(['INPUT','FORBIDDEN','PEER_UNVERIFIED'].includes(event.data?.errorCode)?event.data.errorCode:'PROVIDER_REJECTED', 'QQ account rejected the operation'));
      return;
    }
    if(event.post_type!=='message'||!['private','group'].includes(event.message_type)||String(event.self_id)!==this.actualSelfId||String(event.user_id)===this.actualSelfId)return;
    if(event.message_type==='private'&&event.sub_type!==undefined&&event.sub_type!=='friend')return;
    const id=event.real_seq??event.message_seq??event.message_id;if(!['string','number'].includes(typeof id)||!Number.isFinite(Number(event.time)))return;
    if(event.message_type==='group'&&!/^[1-9]\d{0,19}$/.test(String(event.group_id??'')))return;
    const peerId=event.message_type==='group'?`group:${event.group_id}`:String(event.user_id),senderId=String(event.user_id);
    const parts=Array.isArray(event.message)?event.message:[];
    const text=parts.filter(item=>item?.type==='text'&&typeof item.data?.text==='string').map(item=>item.data.text).join('');
    const attachments=this.config.permissions?.media===true?parts.filter(item=>['image','audio','video','file'].includes(item?.type)&&typeof item.data?.element_id==='string'&&typeof item.data?.message_id==='string').slice(0,10).map(item=>({kind:item.type,elementId:item.data.element_id,messageId:item.data.message_id,name:String(item.data.name??item.type).slice(0,160),size:Number.isSafeInteger(item.data.size)?item.data.size:0})):[];
    if(!text.trim()&&!attachments.length)return;
    this.receive({selfId:this.actualSelfId,peerId,senderId,conversationKind:event.message_type,...(qqGroup(peerId)?{groupId:qqGroup(peerId)}:{}),externalMessageId:`qq:${this.actualSelfId}:${peerId}:${event.time}:${id}`,text:[text,...attachments.map(item=>`[${item.kind}: ${item.name}; messageId=${item.messageId}; elementId=${item.elementId}]`)].filter(Boolean).join('\n'),...(attachments.length?{attachments}:{} )});
  }
  async send({ peerId, text, commandId, signal, beforeDispatch }) {
    if(qqGroup(peerId)){
      this.check(peerId,'reply');this.activeSends++;
      try{this.assertIdentity((await this.rpc('get_login_info',{},{signal})).user_id);const data=await this.rpc('group.send',{peerId,text},{signal,commandId,beforeDispatch:()=>{this.check(peerId,'reply');beforeDispatch();}});return{deliveryStatus:'provider_accepted',externalMessageId:String(data.message_id??'')};}finally{this.activeSends--;}
    }
    this.check(peerId, 'reply');
    this.activeSends++;
    try {
      this.assertIdentity((await this.rpc('get_login_info', {}, { signal })).user_id);
      const data = await this.rpc('send_private_msg', { user_id: peerId, message: [{ type: 'text', data: { text } }] }, { signal, commandId, beforeDispatch: () => { this.check(peerId, 'reply'); beforeDispatch(); } });
      return { deliveryStatus: 'provider_accepted', externalMessageId: String(data.message_id ?? '') };
    } finally { this.activeSends--; }
  }
  proactiveAllowed(peerId){
    const policy=this.config.proactivePolicy;if(this.config.permissions?.proactive!==true||!policy||!Number.isInteger(policy.maxPerHour)||policy.maxPerHour<1)return false;
    if(!qqGroup(peerId)&&!policy.recipientIds?.includes(peerId))return false;
    const hour=new Date(this.now()).getHours(),start=policy.quietStart,end=policy.quietEnd;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||start>23||end<0||end>23)return false;
    if(start!==end&&(start<end?hour>=start&&hour<end:hour>=start||hour<end))return false;
    this.proactiveAdmissions=this.proactiveAdmissions.filter(at=>at>this.now()-3600000);const interval=policy.minIntervalSeconds??0;
    if(!Number.isInteger(interval)||interval<0||interval>86400)return false;
    const last=this.lastProactiveDispatch;if(last!==null&&this.now()-last<interval*1000)return false;
    return this.proactiveAdmissions.length<policy.maxPerHour;
  }
  checkAction(operation,params,{replyMode=false}={}){
    const permission=QQ_OPERATIONS[operation];if(!permission)throw error('INPUT','Unknown QQ action');
    if(this.closed||this.quarantined||!this.active()||this.status!=='connected'||this.actualSelfId!==this.config.expectedSelfId)throw error('PLUGIN_UNAVAILABLE','QQ account is not available');
    if(this.config.permissions?.[permission]!==true)throw error('FORBIDDEN','QQ action permission was not granted');
    if(operation==='media.send'&&replyMode)this.check(params.peerId,'reply');
    if(['private.send','group.send','media.send'].includes(operation)&&!(operation==='media.send'&&replyMode)&&!this.proactiveAllowed(params.peerId))throw error('FORBIDDEN','Proactive QQ scope, quiet hours or quota does not allow this action');
    const group=qqGroup(params.peerId);
    if(group){
      const ids=(this.config.groupAllowlist??[]).map(value=>typeof value==='string'?value:value?.peerId);
      if(this.config.permissions?.groups!==true||!ids.some(value=>value===group||value===params.peerId))throw error('FORBIDDEN','QQ group is outside the granted scope');
    }else if(params.peerId&&this.config.allowlistEnabled&&!this.config.allowlist.includes(params.peerId))throw error('FORBIDDEN','QQ contact is outside the granted scope');
  }
  async action(operation,input,{signal,commandId,beforeDispatch=()=>{},replyMode=false}={}){
    if(input&&Object.hasOwn(input,'scopePeerIds'))throw error('INPUT','QQ query scopes are owned by account policy');
    const params=qqOperationParams(operation,input);
    if(['contacts.list','friends.listRequests'].includes(operation)&&this.config.allowlistEnabled)params.scopePeerIds=[...this.config.allowlist];
    if(operation==='groups.list')params.scopePeerIds=(this.config.groupAllowlist??[]).map(value=>typeof value==='string'?value:value?.peerId).map(value=>qqGroup(value)?value:`group:${value}`);
    this.checkAction(operation,params,{replyMode});const mutating=QQ_MUTATIONS.has(operation);
    if(mutating)this.activeSends++;
    try{
      this.assertIdentity((await this.rpc('get_login_info',{},{signal})).user_id);this.checkAction(operation,params,{replyMode});
      const data=await this.rpc(operation,params,{signal,commandId,beforeDispatch:()=>{this.checkAction(operation,params,{replyMode});beforeDispatch();if(['private.send','group.send','media.send'].includes(operation)&&!(operation==='media.send'&&replyMode)){const at=this.now();this.proactiveAdmissions.push(at);this.lastProactiveDispatch=at;}}});
      if(!mutating)this.checkAction(operation,params,{replyMode});
      // Providers return global indexes. Scope the projection before exposing
      // any private names or request bodies to the trusted coordinator/model.
      if(operation==='contacts.list'&&Array.isArray(data.contacts)&&this.config.allowlistEnabled)data.contacts=data.contacts.filter(row=>this.config.allowlist.includes(row.peerId));
      if(operation==='friends.listRequests'&&Array.isArray(data.requests)&&this.config.allowlistEnabled)data.requests=data.requests.filter(row=>this.config.allowlist.includes(row.peerId));
      if(operation==='groups.list'&&Array.isArray(data.groups)){const ids=(this.config.groupAllowlist??[]).map(value=>typeof value==='string'?value:value?.peerId);data.groups=data.groups.filter(row=>ids.includes(row.peerId)||ids.includes(qqGroup(row.peerId)));}
      return mutating?{...data,deliveryStatus:'provider_accepted',...(data.message_id?{externalMessageId:String(data.message_id)}:{})}:data;
    }finally{if(mutating)this.activeSends--;}
  }
  async stop() {
    await Promise.all([...this.rpcPending.values()].filter(entry=>entry.submitted&&entry.wasDispatched).map(entry=>entry.cancelNative()));
    return { executorQuiescent: this.health().executorQuiescent };
  }
  async close() {
    await super.close();
    await this.stop();
    for (const [echo, entry] of this.rpcPending) {
      if (entry.submitted && entry.wasDispatched) { entry.expire('CANCELLED'); continue; }
      clearTimeout(entry.timer); entry.cleanup?.(); entry.reject?.(error('OUTCOME_UNKNOWN', 'QQ connection closed before confirmation', entry.submitted)); this.rpcPending.delete(echo);
    }
    this.releaseNativeSubscription();
  }
}
