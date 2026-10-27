import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QQChannel } from '../src/channels.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await wait(5); assert.ok(check()); }
const config = extra => ({ id: 'momo-qq', type: 'qq', transport: 'managed', accountId: 'qq-main', expectedSelfId: '123456', policyRevision: 2, permissions: { receive: true, reply: true }, allowlistEnabled: false, allowlist: [], timeoutMs: 80, ...extra });

class NativeFixture {
  selfId = '123456'; connected = true; reply = true;
  listeners = new Set(); calls = []; pending = new Set();
  status() { return { connected: this.connected, actualSelfId: this.selfId }; }
  onNativeEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  channelQuiescent() { return this.pending.size === 0; }
  event(value) { for (const listener of [...this.listeners]) listener(value); }
  async requestChannel(action, params, echo) {
    if (!this.connected) throw Object.assign(new Error('private native diagnostic'), { submitted: false });
    this.calls.push({ action, params, echo });
    if (action === 'get_login_info') queueMicrotask(() => this.event({ echo, status: 'ok', retcode: 0, data: { user_id: this.selfId } }));
    else {
      this.pending.add(echo);
      if (this.reply) queueMicrotask(() => this.complete(echo));
    }
    return { accepted: true };
  }
  complete(echo, success = true) {
    this.pending.delete(echo);
    this.event({ echo, status: success ? 'ok' : 'failed', retcode: success ? 0 : 1, data: { message_id: 'native-77' } });
  }
}

async function channel(t, { settings, ...options } = {}) {
  const native = new NativeFixture(), inbox = [], late = [];
  const adapter = new QQChannel(config(settings), { nativeRuntime: native, onInbox: value => inbox.push(value), onLateReceipt: value => late.push(value), ...options });
  t.after(() => adapter.close());
  await adapter.connect();
  return { native, adapter, inbox, late };
}

test('managed QQ uses authenticated native identity and fixed private text IPC without gateway settings', async t => {
  const { native, adapter } = await channel(t);
  assert.equal(adapter.health().status, 'connected');
  assert.equal(adapter.health().actualSelfId, '123456');
  let dispatched = 0;
  const receipt = await adapter.send({ peerId: '456789', text: '[CQ:at,qq=all] remains plain text', commandId: 'command-native', beforeDispatch: () => { dispatched++; } });
  assert.equal(dispatched, 1);
  assert.deepEqual(receipt, { deliveryStatus: 'provider_accepted', externalMessageId: 'native-77' });
  assert.deepEqual(native.calls.filter(call => call.action === 'send_private_msg').map(({ params }) => params), [{ user_id: '456789', message: '[CQ:at,qq=all] remains plain text' }]);
});

test('managed private ingress preserves text-only scope, identity and the optional empty allowlist', async t => {
  const { native, adapter, inbox } = await channel(t);
  const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '123456', user_id: '456789', message_id: 'native-message', time: 1770000000, message: [{ type: 'text', data: { text: 'hello momo' } }, { type: 'image', data: { file: 'ignored' } }] };
  native.event({ ...event, self_id: '99999' });
  native.event({ ...event, message_type: 'group' });
  native.event({ ...event, user_id: '123456' });
  assert.equal(inbox.length, 0);
  native.event(event);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].text, 'hello momo');
  assert.equal(inbox[0].policyRevision, 2);
  await adapter.ack(inbox[0].inboxId);
  adapter.config.allowlistEnabled = true;
  native.event({ ...event, message_id: 'next-message' });
  await assert.rejects(adapter.send({ peerId: '456789', text: 'not allowed' }), { code: 'FORBIDDEN' });
  assert.equal(inbox.length, 1);
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 0);
});

test('managed QQ never adopts an unbound or changed authenticated identity', async t => {
  const native = new NativeFixture();
  const adapter = new QQChannel(config({ expectedSelfId: '654321' }), { nativeRuntime: native });
  t.after(() => adapter.close());
  await assert.rejects(adapter.connect(), { code: 'ACCOUNT_MISMATCH' });
  const live = await channel(t);
  live.native.selfId = '654321';
  await assert.rejects(live.adapter.send({ peerId: '456789', text: 'wrong account' }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(live.native.calls.filter(call => call.action === 'send_private_msg').length, 0);
});

test('native control acknowledgement cannot complete a send; cancellation keeps the late provider fact', async t => {
  const { native, adapter, late } = await channel(t);
  native.reply = false;
  const controller = new AbortController();
  const pending = adapter.send({ peerId: '456789', text: 'once only', commandId: 'late-native', signal: controller.signal, beforeDispatch() {} });
  await until(() => native.calls.some(call => call.action === 'send_private_msg'));
  const echo = native.calls.find(call => call.action === 'send_private_msg').echo;
  controller.abort();
  await assert.rejects(pending, { code: 'OUTCOME_UNKNOWN', submitted: true });
  assert.equal((await adapter.stop()).executorQuiescent, false);
  assert.equal(adapter.health().executorQuiescent, false);
  assert.equal(late.length, 0);
  native.connected = false;
  native.complete(echo);
  assert.deepEqual(late, [{ commandId: 'late-native', status: 'completed', deliveryStatus: 'provider_accepted', externalMessageId: 'native-77' }]);
  assert.equal((await adapter.stop()).executorQuiescent, true);
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 1);
});

test('native adapter disposal withdraws ingress while retaining bounded correlation for already submitted work', async t => {
  const { native, adapter, late, inbox } = await channel(t);
  native.reply = false;
  const pending = adapter.send({ peerId: '456789', text: 'submitted before removal', commandId: 'closed-native', beforeDispatch() {} });
  await until(() => native.calls.some(call => call.action === 'send_private_msg'));
  const echo = native.calls.find(call => call.action === 'send_private_msg').echo;
  await adapter.close();
  await assert.rejects(pending, { code: 'OUTCOME_UNKNOWN', submitted: true });
  native.event({ post_type: 'message', message_type: 'private', self_id: '123456', user_id: '456789', message_id: 'discard-after-close', time: 1770000000, message: [{ type: 'text', data: { text: 'not admitted' } }] });
  assert.equal(inbox.length, 0);
  native.complete(echo);
  assert.equal(late.length, 1);
  assert.equal(late[0].commandId, 'closed-native');
  assert.equal(native.listeners.size, 0, 'the retained receipt subscription is released after the final correlation');
});

test('managed QQ checks the final dispatch gate and current authentication before writing a send', async t => {
  const { native, adapter } = await channel(t);
  await assert.rejects(adapter.send({ peerId: '456789', text: 'blocked', beforeDispatch: () => { throw new Error('revoked'); } }));
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 0);
  native.connected = false;
  assert.equal(adapter.health().status, 'disconnected');
  assert.equal(adapter.health().capabilities.reply, false);
  await assert.rejects(adapter.send({ peerId: '456789', text: 'disconnected', beforeDispatch() {} }), { submitted: false });
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 0);
});
