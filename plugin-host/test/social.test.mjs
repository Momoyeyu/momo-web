import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PluginHost } from '../src/host.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await wait(10); } assert.ok(fn()); }
async function nativeQQ(_t, { selfId = '123456', reply = true } = {}) {
  const listeners = new Set(), calls = [], pending = new Set();
  let connected = true;
  const push = value => {
    if (value.echo) pending.delete(value.echo);
    for (const listener of [...listeners]) listener(value);
  };
  const runtime = {
    status: () => ({ connected, actualSelfId: selfId }),
    onNativeEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    channelQuiescent: () => pending.size === 0,
    async requestChannel(action, params, echo) {
      calls.push({ action, params, echo });
      if (action === 'get_login_info') queueMicrotask(() => push({ echo, status: 'ok', retcode: 0, data: { user_id: selfId } }));
      else if (action === 'send_private_msg') {
        pending.add(echo);
        if (reply) queueMicrotask(() => push({ echo, status: 'ok', retcode: 0, data: { message_id: 77 } }));
      }
      return { accepted: true };
    },
    async stop() { connected = false; pending.clear(); return { executorQuiescent: true }; },
  };
  return { runtime, calls, setSelfId: value => { selfId = value; }, push };
}
async function setup(t, options = {}) {
  const events = [], host = new PluginHost({ emit: event => events.push(event), ...options }), token = 'test-token-'.repeat(5);
  const req = (method, params = {}) => host.request({ v: 1, id: randomUUID(), token, method, params });
  const hello = await req('hello', { coreInstance: 'core', token }); await req('heartbeat', { activityEpoch: 1 });
  t.after(() => host.close());
  const permit = () => ({ coreInstance: 'core', hostInstance: hello.hostInstance, activityEpoch: host.epoch, runId: randomUUID(), commandId: randomUUID(), expiresAt: Date.now() + 5000 });
  return { req, host, events, permit };
}
const config = () => ({ id: 'momo-qq', type: 'qq', transport: 'managed', accountId: 'qq-main', expectedSelfId: '123456', policyRevision: 1, permissions: { receive: true, reply: true }, allowlistEnabled: false, allowlist: [], timeoutMs: 120 });
const incoming = extra => ({ post_type: 'message', message_type: 'private', self_id: '123456', user_id: '456789', message_id: 12, time: 1770000000, message: [{ type: 'text', data: { text: '你好' } }], ...extra });
const promptScope = extra => ({ pluginId: 'momo-qq', source: 'qq', accountId: 'qq-main', peerId: '456789', policyRevision: 1, ...extra });

test('QQ contributes static current-turn context without exposing account or message data, including after fresh-host recovery', async t => {
  const bot = await nativeQQ(t), { req, events, host } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [{ ...config(), prompt: 'UNTRUSTED_CONFIG_PROMPT' }] });
  // The authenticated core can resume a durably accepted private event after a
  // host restart; no new live event or contacts-list permission is required.
  const recovered = await req('plugins.promptContext', promptScope());
  bot.push(incoming({ message: [{ type: 'text', data: { text: 'UNTRUSTED_INBOUND_TEXT' } }] }));
  await until(() => events.some(e => e.event === 'inbox'));
  await req('channels.ack', { pluginId: 'momo-qq', accountId: 'qq-main', inboxId: events.find(e => e.event === 'inbox').data.inboxId });
  const result = await req('plugins.promptContext', promptScope());
  assert.deepEqual(result, recovered);
  assert.deepEqual(Object.keys(result).sort(), ['pluginId', 'scope', 'sections', 'source']);
  assert.equal(result.pluginId, 'momo-qq'); assert.equal(result.source, 'qq'); assert.equal(result.scope, 'current_turn');
  assert.equal(result.sections.length, 1); assert.equal(result.sections[0].id, 'qq-private-chat');
  assert.match(result.sections[0].content, /QQ/); assert.match(result.sections[0].content, /automatically/);
  assert.match(result.sections[0].content, /plain text/i); assert.match(result.sections[0].content, /Live2D/);
  const serialized = JSON.stringify(result);
  for (const secret of ['123456', '456789', 'qq-main', 'UNTRUSTED_CONFIG_PROMPT', 'UNTRUSTED_INBOUND_TEXT']) assert.ok(!serialized.includes(secret));
  assert.equal(host.commands.size, 0, 'reading context does not accept an execution command');
  assert.deepEqual((await req('plugins.listTools')).tools, []);
});

test('prompt context is authenticated, current, scoped, permitted, and withdrawn immediately with plugin lifecycle', async t => {
  const bot = await nativeQQ(t), { req, events, host } = await setup(t, { qqRuntime: bot.runtime });
  await assert.rejects(host.request({ v: 1, id: randomUUID(), token: 'wrong', method: 'plugins.promptContext', params: promptScope() }), { code: 'UNAUTHORIZED' });
  await assert.rejects(req('plugins.promptContext', promptScope()), { code: 'PLUGIN_UNAVAILABLE' });
  await req('plugins.configure', { plugins: [config()] });
  await assert.rejects(req('plugins.promptContext', promptScope({ peerId: 'display name' })), { code: 'PEER_UNVERIFIED' });
  bot.push(incoming()); await until(() => events.some(e => e.event === 'inbox'));
  for (const change of [{ source: 'wechat' }, { accountId: 'other' }, { policyRevision: 0 }, { policyRevision: '1' }]) await assert.rejects(req('plugins.promptContext', promptScope(change)), { code: 'STALE_CONFIG' });
  await assert.rejects(req('plugins.promptContext', promptScope({ peerId: '123456' })), { code: 'INPUT' });
  host.plugins.get('momo-qq').channel.quarantine();
  await assert.rejects(req('plugins.promptContext', promptScope()), { code: 'PLUGIN_UNAVAILABLE' });
  await req('plugins.configure', { plugins: [{ ...config(), policyRevision: 2, permissions: { receive: true, reply: false } }] });
  bot.push(incoming({ message_id: 13 })); await until(() => events.filter(e => e.event === 'inbox').length > 1);
  await assert.rejects(req('plugins.promptContext', promptScope({ policyRevision: 2 })), { code: 'FORBIDDEN' });
  let release; host.mutations = new Promise(resolve => { release = resolve; });
  const withdrawn = req('plugins.configure', { plugins: [] });
  await assert.rejects(req('plugins.promptContext', promptScope({ policyRevision: 2 })), { code: 'PLUGIN_UNAVAILABLE' });
  release(); await withdrawn;
});

test('QQ prompt context rechecks live identity, receive permission and optional contact scope', async t => {
  const bot = await nativeQQ(t), { req } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [{ ...config(), allowlistEnabled: true, allowlist: [] }] });
  await assert.rejects(req('plugins.promptContext', promptScope()), { code: 'FORBIDDEN' });
  await req('plugins.configure', { plugins: [{ ...config(), permissions: { receive: false, reply: true } }] });
  await assert.rejects(req('plugins.promptContext', promptScope()), { code: 'FORBIDDEN' });
  await req('plugins.configure', { plugins: [config()] });
  bot.setSelfId('654321');
  await assert.rejects(req('plugins.promptContext', promptScope()), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(req('plugins.promptContext', promptScope()), { code: 'PLUGIN_UNAVAILABLE' });
  assert.equal(bot.calls.filter(call => call.action === 'send_private_msg').length, 0);
});

test('prompt context cannot escape when configuration is withdrawn during asynchronous identity verification', async t => {
  const bot = await nativeQQ(t), { req, host } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [config()] });
  const channel = host.plugins.get('momo-qq').channel, verify = channel.verifyPromptScope.bind(channel);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  channel.verifyPromptScope = async peerId => { await verify(peerId); entered(); await pending; };
  const request = req('plugins.promptContext', promptScope());
  await started;
  const withdrawn = req('plugins.configure', { plugins: [] });
  release();
  await assert.rejects(request, { code: 'PLUGIN_UNAVAILABLE' });
  await withdrawn;
});

test('official QQ adapter verifies account, receives private events and sends only fixed text action', async t => {
  const bot = await nativeQQ(t), { req, events, permit } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [config()] });
  const health = await req('channels.health', { pluginId: 'momo-qq' });
  assert.equal(health.actualSelfId, '123456'); assert.equal(health.status, 'connected');
  assert.equal(health.capabilities.reply, true); assert.equal(health.capabilities.groups, false);
  bot.push(incoming()); await until(() => events.some(e => e.event === 'inbox'));
  const message = events.find(e => e.event === 'inbox').data;
  assert.equal(message.peerId, '456789'); assert.equal(message.senderId, '456789'); assert.equal(message.selfId, '123456'); assert.equal(message.text, '你好');
  assert.equal(message.policyRevision, 1); assert.equal(message.conversationKind, 'private');
  await req('channels.ack', { pluginId: 'momo-qq', accountId: 'qq-main', inboxId: message.inboxId });
  const result = await req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: '[CQ:at,qq=all] is plain text', policyRevision: 1, permit: permit() });
  assert.equal(result.receipt.status, 'completed'); assert.equal(result.receipt.deliveryStatus, 'provider_accepted');
  const call = bot.calls.find(c => c.action === 'send_private_msg');
  assert.equal(call.params.message, '[CQ:at,qq=all] is plain text');
  assert.equal(call.params.user_id, '456789'); assert.equal(result.receipt.peerId, '456789');
  assert.deepEqual((await req('plugins.listTools')).tools, []);
  assert.ok(!JSON.stringify(await req('status')).includes('[CQ:at,qq=all]'));
});

test('QQ refuses changed account identity, self echoes and group events', async t => {
  const bot = await nativeQQ(t), { req, events } = await setup(t, { qqRuntime: bot.runtime });
  await assert.rejects(req('plugins.configure', { plugins: [{ ...config(), expectedSelfId: 'wrong' }] }), { code: 'PLUGIN_START' });
  await req('plugins.configure', { plugins: [config()] });
  bot.push(incoming({ self_id: 'wrong' })); bot.push(incoming({ user_id: '123456' })); bot.push(incoming({ message_type: 'group', group_id: '123' }));
  await wait(35); assert.equal(events.filter(e => e.event === 'inbox').length, 0);
});

test('optional allowlist is strict at ingress and dispatch, empty means deny all', async t => {
  const bot = await nativeQQ(t), { req, events, permit } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [{ ...config(), allowlistEnabled: true }] });
  bot.push(incoming()); await wait(25); assert.equal(events.filter(e => e.event === 'inbox').length, 0);
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'no', policyRevision: 1, permit: permit() }), { code: 'FORBIDDEN' });
  await req('plugins.configure', { plugins: [{ ...config(), allowlistEnabled: true, allowlist: ['456789'], policyRevision: 2 }] });
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'stale', policyRevision: 1, permit: permit() }), { code: 'STALE_CONFIG' });
  bot.push(incoming()); await until(() => events.some(e => e.event === 'inbox'));
});

test('a submitted QQ timeout is unknown, never retried, and explicit closed-unknown recovery quarantines plugin', async t => {
  const bot = await nativeQQ(t, { reply: false }), { req, host, permit } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [config()] });
  const p = permit();
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'once', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(bot.calls.filter(c => c.action === 'send_private_msg').length, 1);
  assert.equal(host.receipts.find(r => r.commandId === p.commandId).status, 'unknown');
  const health = await req('channels.health', { pluginId: 'momo-qq' }); assert.equal(health.executorQuiescent, false);
  await bot.runtime.stop();
  assert.equal((await req('channels.health', { pluginId: 'momo-qq' })).executorQuiescent, true);
  const resolution = await req('commands.reconcile', { commandId: p.commandId, status: 'closed_unknown' });
  assert.equal(resolution.receipt.deliveryStatus, 'unknown');
  await req('revoke', { activityEpoch: 2 }); await req('grant', { activityEpoch: 2 });
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'not until resumed', policyRevision: 1, permit: permit() }), { code: 'PLUGIN_UNAVAILABLE' });
});

test('QQ late provider confirmation is preserved on original command after timeout', async t => {
  const bot = await nativeQQ(t, { reply: false }), { req, host, permit } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [config()] });
  const p = permit();
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'late', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  const send = bot.calls.find(c => c.action === 'send_private_msg');
  bot.push({ echo: send.echo, status: 'ok', retcode: 0, data: { message_id: 88 } });
  await until(() => host.receipts.some(r => r.commandId === p.commandId && r.late));
  assert.equal(host.receipts.at(-1).deliveryStatus, 'provider_accepted');
  assert.equal(host.paused, true); assert.equal(host.unresolved.size, 0);
});

test('withdrawn plugin gates prevent retries of unacknowledged old inbox events', async t => {
  const bot = await nativeQQ(t), { req, host, events } = await setup(t, { qqRuntime: bot.runtime });
  await req('plugins.configure', { plugins: [config()], configurationRevision: 1 });
  bot.push(incoming()); await until(() => events.some(e => e.event === 'inbox'));
  let release; host.mutations = new Promise(resolve => { release = resolve; });
  const changed = req('plugins.configure', { plugins: [], configurationRevision: 2 });
  const before = events.filter(e => e.event === 'inbox').length;
  await wait(2100);
  assert.equal(events.filter(e => e.event === 'inbox').length, before);
  release(); await changed;
});

// Legacy account data may exist, but no adapter may reconnect to its gateway.
test('retired WeChat configuration is rejected before any bridge connection or command', async t => {
  const { req, host, events, permit } = await setup(t);
  for (const enabled of [true, false]) {
    await assert.rejects(req('plugins.configure', { plugins: [{ id: 'momo-wechat', type: 'wechat', enabled, endpoint: 'http://127.0.0.1:9848' }] }), { code: 'CONFIG' });
  }
  await assert.rejects(req('plugins.promptContext', { pluginId: 'momo-wechat', source: 'wechat', accountId: 'old-account', peerId: 'old-peer', policyRevision: 1 }), { code: 'PLUGIN_UNAVAILABLE' });
  await assert.rejects(req('channels.send', { pluginId: 'momo-wechat', accountId: 'old-account', peerId: 'old-peer', text: 'must not execute', policyRevision: 1, permit: permit() }), { code: 'PLUGIN_UNAVAILABLE' });
  assert.equal(host.plugins.size, 0);
  assert.equal(host.commands.size, 0);
  assert.ok(!events.some(event => event.event === 'inbox'));
});
