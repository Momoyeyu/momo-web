import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../src/host.mjs';

const token = 'test-token-'.repeat(5);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t, options = {}) {
  const events = [];
  const host = new PluginHost({ emit: event => events.push(event), ...options });
  const req = (method, params = {}, auth = token) => host.request({ v: 1, id: randomUUID(), token: auth, method, params });
  const hello = await req('hello', { coreInstance: 'test-core', token, heartbeatMs: options.heartbeatMs ?? 5000 });
  await req('heartbeat', { activityEpoch: 1 });
  t.after(() => host.close());
  const permit = (extra = {}) => ({ coreInstance: 'test-core', hostInstance: hello.hostInstance, activityEpoch: host.epoch, runId: randomUUID(), commandId: randomUUID(), expiresAt: host.now() + 5000, ...extra });
  return { host, events, req, permit };
}

test('coordinator binding authenticates every request and cannot be rebound', async t => {
  const { req } = await setup(t);
  await assert.rejects(req('status', {}, 'bad'), { code: 'UNAUTHORIZED' });
  await assert.rejects(req('hello', { coreInstance: 'other', token }), { code: 'ALREADY_BOUND' });
});

test('Cordis scopes require provided facades and release effects on disposal', async t => {
  const { host, req } = await setup(t);
  let entered = 0, disposed = 0;
  const plugin = {
    name: 'facade-dependent-test', inject: ['momoCapabilities'],
    apply: ctx => ctx.effect(() => { entered++; assert.equal(typeof ctx.momoCapabilities.checkPermit, 'function'); return () => { disposed++; }; }),
  };
  const fork = host.ctx.plugin(plugin);
  await fork.await();
  assert.equal(entered, 1);
  await fork.dispose();
  assert.equal(disposed, 1);
  let unavailableEntered = false;
  const missing = host.ctx.plugin({ inject: ['missingService'], apply: () => { unavailableEntered = true; } });
  await wait(10);
  assert.equal(unavailableEntered, false);
  await missing.dispose();
  for (let i = 0; i < 12; i++) {
    await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
    await req('plugins.configure', { plugins: [] });
  }
  assert.equal(host.plugins.size, 0);
  assert.equal(host.activity, null);
});

test('revocation stops virtual activity before ACK and preserves original receipt', async t => {
  const { host, req, permit, events } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
  const original = permit();
  await req('virtual.activityStart', { permit: original, tickMs: 10 });
  await wait(35);
  const result = await req('revoke', { activityEpoch: 2 });
  assert.equal(result.stopped, true);
  const ticks = events.filter(item => item.event === 'activity.tick').length;
  await wait(35);
  assert.equal(events.filter(item => item.event === 'activity.tick').length, ticks);
  const stopped = events.find(item => item.event === 'receipt' && item.data.status === 'stopped');
  assert.equal(stopped.data.commandId, original.commandId);
  assert.equal(stopped.data.activityEpoch, 1);
  assert.equal(stopped.data.stale, true);
  await req('heartbeat', { activityEpoch: 2 });
  await assert.rejects(req('virtual.deliver', { permit: permit(), text: 'unsafe' }), { code: 'PAUSED' });
  await req('grant', { activityEpoch: 2 });
  await assert.rejects(req('virtual.deliver', { permit: original, text: 'stale' }), { code: 'STALE_PERMIT' });
  const fresh = permit();
  await req('virtual.deliver', { permit: fresh, text: 'fresh' });
  await assert.rejects(req('virtual.deliver', { permit: fresh, text: 'duplicate' }), { code: 'DUPLICATE_COMMAND' });
  assert.equal(host.receipts.filter(item => item.status === 'delivered').length, 1);
});

test('heartbeat expiration independently stops side effects and heartbeat cannot resume', async t => {
  let now = 1000;
  const { req, host, permit, events } = await setup(t, { now: () => now, heartbeatMs: 300 });
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
  await req('virtual.activityStart', { permit: permit(), tickMs: 10 });
  now += 350;
  await wait(120);
  assert.equal(host.paused, true);
  assert.equal(host.activity, null);
  assert.ok(events.some(item => item.event === 'host.paused'));
  await req('heartbeat', { activityEpoch: host.epoch });
  assert.equal(host.paused, true);
  await assert.rejects(req('grant', { activityEpoch: host.epoch }), { code: 'PAUSED' });
});

test('expired or wrong-host permit never dispatches', async t => {
  const { req, permit, host } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
  await assert.rejects(req('virtual.deliver', { permit: permit({ hostInstance: 'old-host' }), text: 'wrong' }), { code: 'STALE_PERMIT' });
  await assert.rejects(req('virtual.deliver', { permit: permit({ expiresAt: 0 }), text: 'expired' }), { code: 'INVALID_PERMIT' });
  assert.equal(host.receipts.length, 0);
});

test('virtual inbound can be received while paused without generating an outbound', async t => {
  const { req, events } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
  await req('revoke', { activityEpoch: 2 });
  await req('virtual.receive', { messageId: 'm1', accountId: 'a1', text: 'hello' });
  assert.equal(events.filter(item => item.event === 'inbox').length, 1);
  assert.equal(events.filter(item => item.event === 'receipt' && item.data.status === 'delivered').length, 0);
});

test('MCP connections persist across turns and config reconciliation never closes another plugin', async t => {
  const { req, permit, host } = await setup(t);
  const config = { id: 'echo', type: 'mcp', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] };
  const virtual = { id: 'virtual', type: 'virtual' };
  await req('plugins.configure', { plugins: [config, virtual] });
  const tools = await req('plugins.listTools');
  assert.deepEqual(tools.tools.map(item => item.name), ['echo__echo', 'echo__slow']);
  const call = async () => JSON.parse((await req('plugins.callTool', { name: 'echo__echo', arguments: { text: 'hello' }, permit: permit() })).result.content[0].text);
  const first = await call();
  await req('plugins.configure', { plugins: [config] });
  const second = await call();
  assert.equal(second.pid, first.pid);
  assert.equal(second.calls, 2);
  await req('plugins.configure', { plugins: [] });
  assert.deepEqual((await req('plugins.listTools')).tools, []);
  assert.throws(() => process.kill(first.pid, 0), { code: 'ESRCH' });
  await assert.rejects(req('plugins.callTool', { name: 'echo__echo', permit: permit() }), { code: 'TOOL_UNAVAILABLE' });
  assert.equal(host.inflight.size, 0);
});

test('revoke cancels an active MCP call and closes its child before granting another epoch', async t => {
  const { req, permit, host } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'echo', type: 'mcp', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] }] });
  const childPid = host.plugins.get('echo').transport.pid;
  const original = permit();
  const pending = req('plugins.callTool', { name: 'echo__slow', permit: original });
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await wait(30);
  const result = await req('revoke', { activityEpoch: 2 });
  await rejected;
  assert.equal(result.stopped, true);
  assert.equal(host.inflight.size, 0);
  assert.equal(host.plugins.get('echo').connected, false);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  assert.ok(host.receipts.some(item => item.commandId === original.commandId && item.status === 'unknown' && item.stale));
});

test('MCP catalog notifications refresh the existing connection and advance its version', async t => {
  const { req, permit, events } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'echo', type: 'mcp', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] }] });
  const before = await req('plugins.listTools');
  await req('plugins.callTool', { name: 'echo__echo', arguments: { addTool: true }, permit: permit() });
  for (let i = 0; i < 30 && !events.some(item => item.event === 'tools.changed'); i++) await wait(10);
  const after = await req('plugins.listTools');
  assert.ok(after.version > before.version);
  assert.ok(after.tools.some(tool => tool.name === 'echo__new'));
});

test('known execution completion crossing revoke is recorded against the original command', async t => {
  const { req, permit, host } = await setup(t);
  let complete;
  const resultPromise = new Promise(resolve => { complete = resolve; });
  host.plugins.set('late', { id: 'late', enabled: true, connected: true, config: { type: 'mcp', transport: 'stdio' }, tools: [{ name: 'run' }], controllers: new Set(), client: { callTool: () => resultPromise, close: async () => { complete({ content: [{ type: 'text', text: 'effect already happened' }] }); } } });
  const original = permit();
  const pending = req('plugins.callTool', { name: 'late__run', permit: original });
  const ack = await req('revoke', { activityEpoch: 2 });
  const response = await pending;
  assert.equal(ack.stopped, true);
  assert.equal(response.receipt.commandId, original.commandId);
  assert.equal(response.receipt.status, 'completed');
  assert.equal(response.receipt.stale, true);
  assert.equal(response.receipt.activityEpoch, 1);
});

test('in-flight HTTP effect does not produce a false stop ACK or permit automatic resume', async t => {
  const { req, permit, host } = await setup(t);
  let complete;
  const pendingResult = new Promise(resolve => { complete = resolve; });
  host.plugins.set('remote', { id: 'remote', enabled: true, connected: true, config: { type: 'mcp', transport: 'streamable-http' }, tools: [{ name: 'run' }], controllers: new Set(), client: { callTool: () => pendingResult, close: async () => { complete({ content: [] }); } } });
  const pending = req('plugins.callTool', { name: 'remote__run', permit: permit() });
  const result = await req('revoke', { activityEpoch: 2 });
  await pending;
  assert.equal(result.stopped, false);
  assert.equal(result.unknownExternal, true);
  await assert.rejects(req('grant', { activityEpoch: 2 }), { code: 'PAUSED' });
});

test('failed plugin configuration does not expose configured headers or child stderr', async t => {
  const { req } = await setup(t);
  await assert.rejects(req('plugins.configure', { plugins: [{ id: 'broken', type: 'mcp', transport: 'stdio', command: '/not/a/real/command', env: { SECRET: 'must-not-leak' } }] }), error => {
    assert.equal(error.code, 'PLUGIN_START');
    assert.equal(error.message, 'Plugin broken could not start');
    assert.ok(!String(error.stack).includes('must-not-leak'));
    return true;
  });
});

test('long activities require explicit renewal of the same authorized command', async t => {
  let now = 1000;
  const { req, permit, host } = await setup(t, { now: () => now });
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
  const original = permit({ expiresAt: now + 100 });
  await req('virtual.activityStart', { permit: original, tickMs: 10 });
  now += 50;
  await req('virtual.activityRenew', { permit: { ...original, expiresAt: now + 500 } });
  now += 100;
  await wait(20);
  assert.ok(host.activity);
  await assert.rejects(req('virtual.activityRenew', { permit: permit() }), { code: 'ACTIVITY_UNAVAILABLE' });
  now += 500;
  await wait(20);
  assert.equal(host.activity, null);
});

test('repeated MCP enable/disable leaves no owned child or active connection', async t => {
  const { req, host } = await setup(t);
  const config = { id: 'echo', type: 'mcp', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] };
  for (let cycle = 0; cycle < 5; cycle++) {
    await req('plugins.configure', { plugins: [config] });
    const pid = host.plugins.get('echo').transport.pid;
    await req('plugins.configure', { plugins: [] });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(host.plugins.size, 0);
    assert.equal(host.inflight.size, 0);
  }
});

test('new settings withdraw gates before a blocked lifecycle queue reaches disposal', async t => {
  const { req, host, permit } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }], configurationRevision: 1 });
  let release;
  host.mutations = new Promise(resolve => { release = resolve; });
  const pending = req('plugins.configure', { plugins: [], configurationRevision: 2 });
  assert.equal(host.plugins.get('virtual').enabled, false);
  await assert.rejects(req('virtual.deliver', { permit: permit(), text: 'blocked' }), { code: 'PLUGIN_UNAVAILABLE' });
  release(); await pending;
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }], configurationRevision: 1 });
  assert.equal(host.plugins.size, 0);
});

test('tolerating a failed plugin still starts later healthy plugins', async t => {
  const { req } = await setup(t);
  const result = await req('plugins.configure', { plugins: [{ id: 'broken', type: 'mcp', transport: 'stdio', command: '/no/real/command' }, { id: 'virtual', type: 'virtual' }], tolerateErrors: true });
  assert.deepEqual(result.failures, [{ id: 'broken', code: 'PLUGIN_START' }]);
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].id, 'virtual');
});
