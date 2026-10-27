import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PluginHost, HostError } from '../src/host.mjs';
import { QQRuntimeError } from '../src/qq-runtime.mjs';

const token = 'managed-runtime-host-test-'.repeat(2);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let index = 0; index < 100 && !check(); index++) await tick(); assert.ok(check()); }
function fixture() {
  const calls = [];
  const runtime = {
    status: params => { calls.push(['status', params]); return { provider: 'qq', status: 'qr_pending', connected: false, running: true, ...(params?.authenticatedDetail ? { qr: { dataUrl: 'private-qr' } } : {}), ...(params?.restoreDetail ? { loginRevision: 7 } : {}) }; },
    ...Object.fromEntries(['begin', 'restore', 'refreshQR', 'cancel', 'stop', 'forget'].map(method => [method, async params => { calls.push([method, params]); return { provider: 'qq', status: method === 'stop' ? 'stopped' : 'qr_pending', executorQuiescent: method === 'stop' }; }])),
  };
  return { calls, runtime };
}
async function hostFixture(t, options = {}) {
  const host = new PluginHost(options);
  const request = (method, params = {}, auth = token) => host.request({ v: 1, id: randomUUID(), method, params, token: auth });
  await request('hello', { coreInstance: 'managed-runtime-core', token });
  t.after(() => host.close());
  return { host, request };
}

test('managed QQ login can run while dormant but still requires coordinator authentication', async t => {
  const { calls, runtime } = fixture();
  const { host, request } = await hostFixture(t, { qqRuntime: runtime });
  assert.equal(host.paused, true);
  await assert.rejects(request('qq.runtime.begin', { ownerAction: true }, 'wrong'), { code: 'UNAUTHORIZED' });
  assert.equal(calls.length, 0);
  await request('qq.runtime.begin', { ownerAction: true, expectedSelfId: '123456', command: '/untrusted', env: { HOME: '/untrusted' } });
  assert.deepEqual(calls, [['begin', { ownerAction: true, expectedSelfId: '123456' }]]);
  assert.equal(host.paused, true);
  assert.equal(host.inflight.size, 0);
});

test('background restoration is an authenticated private RPC with a whitelisted ownership snapshot', async t => {
  const { calls, runtime } = fixture();
  const { request } = await hostFixture(t, { qqRuntime: runtime });
  const snapshot = { ownerAction: true, expectedSelfId: '123456', expectedAttemptId: randomUUID(), expectedLoginRevision: 7 };
  await assert.rejects(request('qq.runtime.restore', snapshot, 'wrong'), { code: 'UNAUTHORIZED' });
  assert.equal(calls.length, 0);
  assert.equal((await request('qq.runtime.status')).loginRevision, undefined);
  assert.equal((await request('qq.runtime.status', { restoreDetail: true })).loginRevision, 7);
  await request('qq.runtime.restore', { ...snapshot, command: '/untrusted', env: { HOME: '/untrusted' }, restoreSession: false });
  assert.deepEqual(calls.at(-1), ['restore', snapshot]);
  runtime.restore = async () => { throw new QQRuntimeError('ATTEMPT_CANCELLED'); };
  await assert.rejects(request('qq.runtime.restore', snapshot), error => error instanceof HostError && error.code === 'ATTEMPT_CANCELLED');
});

test('runtime survives plugin policy rebuilds and only explicit authenticated status exposes the QR', async t => {
  const { calls, runtime } = fixture();
  const { host, request } = await hostFixture(t, { qqRuntime: runtime });
  assert.equal((await request('qq.runtime.status')).qr, undefined);
  assert.equal((await request('qq.runtime.status', { authenticatedDetail: true })).qr.dataUrl, 'private-qr');
  await request('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
  await request('plugins.configure', { plugins: [] });
  assert.equal(calls.some(([method]) => method === 'stop'), false);
  await request('qq.runtime.refresh', { ownerAction: true, expectedSelfId: '999999', args: ['untrusted'] });
  assert.deepEqual(calls.at(-1), ['refreshQR', { ownerAction: true }]);
  await request('qq.runtime.cancel');
  await request('qq.runtime.forget', { ownerAction: true });
  await request('qq.runtime.stop');
  assert.deepEqual(calls.slice(-3), [['cancel', undefined], ['forget', { ownerAction: true }], ['stop', undefined]]);
  await host.close();
  assert.equal(calls.filter(([method]) => method === 'stop').length, 2);
});

test('absent resources stay lazy and safe runtime errors retain stable codes', async t => {
  const { request } = await hostFixture(t);
  assert.equal((await request('qq.runtime.status')).running, false);
  await assert.rejects(request('qq.runtime.begin', { ownerAction: true }), error => error instanceof HostError && error.code === 'RESOURCE_UNAVAILABLE');
  const { runtime } = fixture();
  runtime.begin = async () => { throw new QQRuntimeError('ACCOUNT_MISMATCH'); };
  const other = await hostFixture(t, { qqRuntime: runtime });
  await assert.rejects(other.request('qq.runtime.begin', { ownerAction: true }), error => error instanceof HostError && error.code === 'ACCOUNT_MISMATCH');
});

test('shutdown never acknowledges a still-owned native descendant as stopped', async t => {
  const { runtime } = fixture();
  runtime.stop = async () => ({ provider: 'qq', status: 'error', executorQuiescent: false });
  const { request } = await hostFixture(t, { qqRuntime: runtime });
  assert.equal((await request('shutdown')).stopped, false);
});

test('a malformed trusted startup binding fails atomically and cannot be supplied through plugin settings', async t => {
  const host = new PluginHost(); t.after(() => host.close());
  const request = (method, params) => host.request({ v: 1, id: randomUUID(), token, method, params });
  await assert.rejects(request('hello', { coreInstance: 'managed-runtime-core', token, qqRuntime: { command: '/untrusted' } }), { code: 'RESOURCE_INVALID' });
  await request('hello', { coreInstance: 'managed-runtime-core', token });
  await request('plugins.configure', { plugins: [], qqRuntime: { command: '/untrusted' } });
  await assert.rejects(request('qq.runtime.begin', { ownerAction: true, privateRoot: '/untrusted' }), { code: 'RESOURCE_UNAVAILABLE' });
});

test('forget requires explicit owner intent before withdrawing any QQ plugin or invoking native code', async t => {
  const { calls, runtime } = fixture();
  const { host, request } = await hostFixture(t, { qqRuntime: runtime });
  const plugin = { id: 'momo-qq', config: { type: 'qq' }, enabled: true, connected: true, controllers: new Set() };
  host.plugins.set(plugin.id, plugin);
  const version = host.toolVersion;
  for (const ownerAction of [false, undefined, 'true']) {
    await assert.rejects(request('qq.runtime.forget', { ownerAction }), { code: 'OWNER_ACTION_REQUIRED' });
    assert.equal(host.plugins.get(plugin.id), plugin);
    assert.equal(plugin.enabled, true);
    assert.equal(plugin.connected, true);
    assert.equal(host.toolVersion, version);
  }
  assert.deepEqual(calls, []);
});

test('forget withdraws only QQ and starts native cleanup without waiting for blocked plugin disposal', async t => {
  const { runtime } = fixture();
  const { host, request } = await hostFixture(t, { qqRuntime: runtime });
  let release, disposals = 0, mcpClosed = 0, nativeCalls = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const plugin = { id: 'momo-qq', config: { type: 'qq' }, enabled: true, connected: true, controllers: new Set([controller]), fiber: { dispose: () => { disposals++; return blocked; } } };
  const mcp = { id: 'slow-mcp', config: { type: 'mcp' }, enabled: true, connected: true, controllers: new Set(), client: { close: async () => { mcpClosed++; await blocked; } } };
  host.plugins.set(plugin.id, plugin); host.plugins.set(mcp.id, mcp);
  const pendingMutation = host.mutate(() => blocked);
  const version = host.toolVersion;
  runtime.forget = async () => {
    nativeCalls++;
    assert.equal(host.plugins.has(plugin.id), false);
    assert.equal(plugin.enabled, false);
    assert.equal(plugin.connected, false);
    assert.equal(controller.signal.aborted, true);
    return { provider: 'qq', status: 'idle', executorQuiescent: true };
  };
  try {
    const result = await Promise.race([request('qq.runtime.forget', { ownerAction: true }), new Promise(resolve => setTimeout(() => resolve(null), 100))]);
    assert.equal(result?.status, 'idle', 'logout must bypass the unrelated configuration queue');
    assert.equal(nativeCalls, 1);
    assert.equal(disposals, 1);
    assert.equal(host.toolVersion, version + 1);
    assert.equal(host.plugins.get(mcp.id), mcp);
    assert.equal(mcp.enabled, true);
    assert.equal(mcpClosed, 0);
  } finally { release(); await pendingMutation; }
});

test('a native forget failure never restores the withdrawn QQ business adapter', async t => {
  const { runtime } = fixture();
  const { host, request } = await hostFixture(t, { qqRuntime: runtime });
  const plugin = { id: 'momo-qq', config: { type: 'qq' }, enabled: true, connected: true, controllers: new Set() };
  host.plugins.set(plugin.id, plugin);
  runtime.forget = async () => { throw new QQRuntimeError('FORGET_FAILED'); };
  await assert.rejects(request('qq.runtime.forget', { ownerAction: true }), { code: 'FORGET_FAILED' });
  assert.equal(host.plugins.has(plugin.id), false);
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.connected, false);
});

test('forget retires QQ callbacks while preserving submitted unknown sends and original late delivery facts', async t => {
  const listeners = new Set(), sent = [], events = [], pending = new Set();
  let connected = true;
  const push = value => { if (value.echo) pending.delete(value.echo); for (const listener of [...listeners]) listener(value); };
  const runtime = {
    status: () => ({ connected, actualSelfId: connected ? '123456' : null }),
    channelQuiescent: () => pending.size === 0,
    onNativeEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async requestChannel(action, params, echo) {
      if (action === 'get_login_info') queueMicrotask(() => push({ echo, status: 'ok', retcode: 0, data: { user_id: '123456' } }));
      else { sent.push({ action, params, echo }); pending.add(echo); }
      return { accepted: true };
    },
    async forget() { connected = false; return { provider: 'qq', status: 'idle', executorQuiescent: true }; },
    async stop() { connected = false; pending.clear(); return { executorQuiescent: true }; },
  };
  const { host, request } = await hostFixture(t, { qqRuntime: runtime, emit: value => events.push(value) });
  await request('heartbeat', { activityEpoch: 1 });
  const config = { id: 'momo-qq', type: 'qq', transport: 'managed', accountId: 'qq-main', expectedSelfId: '123456', policyRevision: 1, permissions: { receive: true, reply: true }, allowlistEnabled: false, allowlist: [] };
  await request('plugins.configure', { plugins: [config] });
  const permit = { coreInstance: 'managed-runtime-core', hostInstance: host.hostInstance, activityEpoch: host.epoch, runId: randomUUID(), commandId: randomUUID(), expiresAt: Date.now() + 5000 };
  const sending = request('channels.send', { pluginId: config.id, accountId: config.accountId, peerId: '456789', text: 'Only one submission', policyRevision: 1, permit });
  const unknown = assert.rejects(sending, { code: 'OUTCOME_UNKNOWN' });
  await until(() => sent.length === 1);
  await request('qq.runtime.forget', { ownerAction: true });
  await unknown;
  assert.equal(host.plugins.has(config.id), false);
  assert.equal(host.unresolved.has(permit.commandId), true);
  assert.equal(host.receipts.at(-1).status, 'unknown');
  assert.equal(listeners.size, 1, 'the retired adapter still owns its submitted receipt');
  push({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '123456', user_id: '456789', message_id: 99, time: 1770000000, message: [{ type: 'text', data: { text: 'Must not enter after logout' } }] });
  assert.equal(events.some(value => value.event === 'inbox'), false);
  push({ echo: sent[0].echo, status: 'ok', retcode: 0, data: { message_id: 'late-provider-77' } });
  await until(() => host.receipts.some(value => value.commandId === permit.commandId && value.late));
  const fact = host.receipts.at(-1);
  assert.equal(fact.commandId, permit.commandId);
  assert.equal(fact.status, 'completed');
  assert.equal(fact.deliveryStatus, 'provider_accepted');
  assert.equal(fact.externalMessageId, 'late-provider-77');
  assert.equal(host.unresolved.size, 0);
  assert.equal(host.paused, true, 'delivery evidence cannot reactivate momo');
  assert.equal(sent.length, 1);
  assert.equal(listeners.size, 0);
});
