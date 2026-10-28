import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { QQRuntimeManager } from '../src/qq-runtime.mjs';
import { PluginHost } from '../src/host.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await wait(5); assert.ok(check()); }
const configuration = { id: 'momo-qq', type: 'qq', transport: 'managed', accountId: 'native-account', expectedSelfId: '123456', policyRevision: 1, permissions: { receive: true, reply: true }, allowlistEnabled: false, allowlist: [], timeoutMs: 80 };

async function setup(t, { reply = true } = {}) {
  const child = new EventEmitter(), sent = [], events = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { child.emit('exit', 0); return true; };
  const ipc = value => child.stdout.write('MOMO_QQ_IPC ' + JSON.stringify(value) + '\n');
  const complete = echo => ipc({ event: 'onebot', data: { echo, status: 'ok', retcode: 0, data: { message_id: 'native-provider-77' } } });
  child.stdin = new Writable({ write(chunk, encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const command = JSON.parse(line);
      queueMicrotask(() => {
        ipc({ id: command.id, result: { attemptId: command.params.attemptId, ...(command.method === 'connect' ? { selfId: '123456' } : {}) } });
        if (command.method === 'onebot') {
          if (command.params.action === 'get_login_info') ipc({ event: 'onebot', data: { echo: command.params.echo, status: 'ok', retcode: 0, data: { user_id: '123456' } } });
          else { sent.push(command.params); if (reply) complete(command.params.echo); }
        }
        if (command.method === 'stop') child.emit('exit', 0);
      });
    }
    done();
  } });
  const runtime = new QQRuntimeManager({ createTransport: () => child, requestTimeoutMs: 100, stopTimeoutMs: 20 });
  const host = new PluginHost({ qqRuntime: runtime, emit: event => events.push(event), stopTimeoutMs: 100 });
  t.after(() => host.close());
  const token = 'private-host-capability-'.repeat(3);
  const request = (method, params = {}) => host.request({ v: 1, id: randomUUID(), token, method, params });
  const hello = await request('hello', { coreInstance: 'test-core', token });
  await request('heartbeat', { activityEpoch: 1 });
  await request('qq.runtime.begin', { ownerAction: true, expectedSelfId: '123456' });
  await request('plugins.configure', { plugins: [configuration] });
  const permit = () => ({ coreInstance: 'test-core', hostInstance: hello.hostInstance, activityEpoch: host.epoch, runId: randomUUID(), commandId: randomUUID(), expiresAt: Date.now() + 5000 });
  return { host, runtime, request, sent, events, complete, ipc, permit };
}

test('native engine, Cordis channel and permit gates integrate without any OneBot listening port', async t => {
  const { host, request, sent, events, ipc, permit } = await setup(t);
  assert.equal((await request('channels.health', { pluginId: 'momo-qq' })).status, 'connected');
  ipc({ event: 'onebot', data: { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '123456', user_id: '456789', message_id: 'incoming-native', time: 1770000000, message: [{ type: 'text', data: { text: 'Hello over native QQ' } }] } });
  assert.equal(events.find(event => event.event === 'inbox').data.accountId, 'native-account');
  assert.equal((await request('plugins.promptContext', { pluginId: 'momo-qq', source: 'qq', accountId: 'native-account', peerId: '456789', policyRevision: 1 })).sections[0].id, 'qq-private-chat');
  const result = await request('channels.send', { pluginId: 'momo-qq', accountId: 'native-account', peerId: '456789', text: 'A single native reply', policyRevision: 1, permit: permit() });
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.deliveryStatus, 'provider_accepted');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].params, { user_id: '456789', message: 'A single native reply' });
  assert.ok(!JSON.stringify(host.status()).includes('private-host-capability'));
});

test('native unknown sends survive auth cancellation and plugin disposal as original late receipt facts', async t => {
  const { host, runtime, request, sent, complete, permit } = await setup(t, { reply: false });
  const p = permit();
  await assert.rejects(request('channels.send', { pluginId: 'momo-qq', accountId: 'native-account', peerId: '456789', text: 'One submission only', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(runtime.channelQuiescent(), false);
  assert.equal((await request('channels.health', { pluginId: 'momo-qq' })).executorQuiescent, false);
  await assert.rejects(request('commands.reconcile', { commandId: p.commandId, status: 'closed_unknown' }), { code: 'BUSY' });
  await request('qq.runtime.cancel');
  await request('plugins.configure', { plugins: [] });
  complete(sent[0].echo);
  await until(() => host.receipts.some(receipt => receipt.commandId === p.commandId && receipt.late));
  assert.equal(host.receipts.at(-1).status, 'completed');
  assert.equal(host.receipts.at(-1).deliveryStatus, 'provider_accepted');
  assert.equal(host.unresolved.size, 0);
  assert.equal(host.paused, true, 'a provider fact never grants a new business activity');
  assert.equal(sent.length, 1);
});

test('automatic QQ recovery stops the owned executor and closes only its wait without claiming delivery', async t => {
  const { host, runtime, request, sent, permit } = await setup(t, { reply: false });
  const p = permit();
  await assert.rejects(request('channels.send', { pluginId: 'momo-qq', accountId: 'native-account', peerId: '456789', text: 'One uncertain submission', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  const result = await request('qq.settleUnknown', { commandId: p.commandId, accountId: 'native-account' });
  assert.equal(result.settled, true);
  assert.equal(result.executorQuiescent, true);
  assert.equal(result.receipt.status, 'closed_unknown');
  assert.equal(result.receipt.deliveryStatus, 'unknown');
  assert.equal(result.receipt.automatic, true);
  assert.equal(result.receipt.runId, p.runId);
  assert.equal(runtime.status().executorQuiescent, true);
  assert.equal(host.unresolved.size, 0);
  assert.equal(host.plugins.get('momo-qq').enabled, false);
  assert.equal(host.plugins.get('momo-qq').channel.quarantined, true);
  assert.equal(host.paused, true, 'settling a wait cannot grant attention');
  assert.equal(sent.length, 1);
  const duplicate = await request('qq.settleUnknown', { commandId: p.commandId, accountId: 'native-account' });
  assert.equal(duplicate.receipt.seq, result.receipt.seq);
});

test('automatic QQ recovery requires current-host ownership and verified native quiescence', async t => {
  const { host, runtime, request, permit } = await setup(t, { reply: false });
  const p = permit();
  assert.equal((await request('qq.settleUnknown', { commandId: 'prior-host-command', accountId: 'native-account' })).settled, false);
  await assert.rejects(request('channels.send', { pluginId: 'momo-qq', accountId: 'native-account', peerId: '456789', text: 'Unknown only', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(request('qq.settleUnknown', { commandId: p.commandId, accountId: 'different-account' }), { code: 'INPUT' });
  const stop = runtime.stop.bind(runtime);
  runtime.stop = async () => ({ executorQuiescent: false });
  const refused = await request('qq.settleUnknown', { commandId: p.commandId, accountId: 'native-account' });
  assert.equal(refused.settled, false);
  assert.equal(host.unresolved.has(p.commandId), true);
  assert.equal(host.receipts.at(-1).status, 'unknown');
  runtime.stop = stop;
});

test('a genuine late QQ fact during automatic stop stays on its original command and no unknown MCP effect is settled', async t => {
  const { host, runtime, request, sent, complete, permit } = await setup(t, { reply: false });
  const p = permit();
  await assert.rejects(request('channels.send', { pluginId: 'momo-qq', accountId: 'native-account', peerId: '456789', text: 'Original fact only', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  const unrelated = { commandId: 'mcp-unknown', runId: 'another-run', kind: 'mcp.tool', pluginId: 'other', hostInstance: host.hostInstance };
  host.commands.set(unrelated.commandId, unrelated); host.unresolved.set(unrelated.commandId, unrelated);
  await assert.rejects(request('qq.settleUnknown', { commandId: unrelated.commandId, accountId: 'native-account' }), { code: 'INPUT' });
  const stop = runtime.stop.bind(runtime);
  runtime.stop = async () => { complete(sent[0].echo); return stop(); };
  const result = await request('qq.settleUnknown', { commandId: p.commandId, accountId: 'native-account' });
  assert.equal(result.receipt.status, 'completed');
  assert.equal(result.receipt.deliveryStatus, 'provider_accepted');
  assert.equal(result.receipt.commandId, p.commandId);
  assert.equal(result.receipt.runId, p.runId);
  assert.equal(result.receipt.late, true);
  assert.equal(host.receipts.filter(r => r.commandId === p.commandId && r.status === 'closed_unknown').length, 0);
  assert.equal(host.unresolved.has(unrelated.commandId), true);
  assert.equal(sent.length, 1);
});

test('graceful shutdown persists owned QQ quiescence as unknown delivery before the old host exits', async t => {
  const { host, runtime, request, sent, permit } = await setup(t, { reply: false });
  const p = permit();
  await assert.rejects(request('channels.send', { pluginId: 'momo-qq', accountId: 'native-account', peerId: '456789', text: 'No replay after restart', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  await host.close();
  assert.equal(runtime.status().executorQuiescent, true);
  const closed = host.receipts.findLast(receipt => receipt.commandId === p.commandId);
  assert.equal(closed.status, 'closed_unknown');
  assert.equal(closed.deliveryStatus, 'unknown');
  assert.equal(closed.executorQuiescent, true);
  assert.equal(closed.runId, p.runId);
  assert.equal(host.unresolved.size, 0);
  assert.equal(sent.length, 1);
});

test('shutdown also safely closes a QQ send that was still in flight when stop began', async t => {
  const { host, request, sent, permit } = await setup(t, { reply: false });
  const p = permit();
  const pending = request('channels.send', { pluginId: 'momo-qq', accountId: 'native-account', peerId: '456789', text: 'Only the original submission', policyRevision: 1, permit: p });
  const rejected = assert.rejects(pending, { code: 'OUTCOME_UNKNOWN' });
  await until(() => sent.length === 1);
  await host.close();
  await rejected;
  const closed = host.receipts.findLast(receipt => receipt.commandId === p.commandId);
  assert.equal(closed.status, 'closed_unknown');
  assert.equal(closed.deliveryStatus, 'unknown');
  assert.equal(closed.executorQuiescent, true);
  assert.equal(closed.runId, p.runId);
  assert.equal(sent.length, 1);
});
