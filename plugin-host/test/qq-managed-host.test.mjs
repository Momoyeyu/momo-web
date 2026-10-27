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
