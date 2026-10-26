import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PluginHost } from '../src/host.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await wait(10); } assert.ok(fn()); }
async function onebot(t, { selfId = '123456', reply = true } = {}) {
  const sockets = new Set(), calls = [];
  const frame = value => { const b = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(b.length < 126 ? [0x81, b.length] : [0x81, 126, b.length >> 8, b.length & 255]), b]); };
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    assert.equal(new URL(request.url, 'http://localhost').searchParams.get('access_token'), 'private-token');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        let len = buffer[1] & 127, offset = 2;
        if (len === 126) { if (buffer.length < 8) return; len = buffer.readUInt16BE(2); offset = 4; }
        if (buffer.length < offset + 4 + len) return;
        const opcode = buffer[0] & 15, mask = buffer.subarray(offset, offset + 4), body = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
        buffer = buffer.subarray(offset + 4 + len);
        if (opcode === 8) { socket.end(); continue; }
        for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        const message = JSON.parse(body.toString()); calls.push(message);
        if (message.action === 'get_login_info') socket.write(frame({ echo: message.echo, status: 'ok', retcode: 0, data: { user_id: selfId, nickname: 'momo' } }));
        else if (message.action === 'send_private_msg' && reply) socket.write(frame({ echo: message.echo, status: 'ok', retcode: 0, data: { message_id: 77 } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `ws://127.0.0.1:${server.address().port}`, calls, push: data => { for (const socket of sockets) socket.write(frame(data)); } };
}
async function setup(t, options = {}) {
  const directory = options.channelStatePath ? null : await mkdtemp(join(tmpdir(), 'momo-host-test-'));
  const events = [], host = new PluginHost({ emit: event => events.push(event), channelStatePath: directory ? join(directory, 'cursors.json') : options.channelStatePath, ...options }), token = 'test-token-'.repeat(5);
  const req = (method, params = {}) => host.request({ v: 1, id: randomUUID(), token, method, params });
  const hello = await req('hello', { coreInstance: 'core', token }); await req('heartbeat', { activityEpoch: 1 });
  t.after(async () => { await host.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  const permit = () => ({ coreInstance: 'core', hostInstance: hello.hostInstance, activityEpoch: host.epoch, runId: randomUUID(), commandId: randomUUID(), expiresAt: Date.now() + 5000 });
  return { req, host, events, permit };
}
const config = endpoint => ({ id: 'momo-qq', type: 'qq', endpoint, accountId: 'qq-main', expectedSelfId: '123456', credential: { token: 'private-token' }, policyRevision: 1, permissions: { receive: true, reply: true }, allowlistEnabled: false, allowlist: [], timeoutMs: 120 });
const incoming = extra => ({ post_type: 'message', message_type: 'private', self_id: '123456', user_id: '456789', message_id: 12, time: 1770000000, message: [{ type: 'text', data: { text: '你好' } }], ...extra });

test('official QQ adapter verifies account, receives private events and sends only fixed text action', async t => {
  const bot = await onebot(t), { req, events, permit } = await setup(t);
  await req('plugins.configure', { plugins: [config(bot.endpoint)] });
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
  assert.deepEqual(call.params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all] is plain text' } }]);
  assert.equal(call.params.user_id, '456789'); assert.equal(result.receipt.peerId, '456789');
  assert.deepEqual((await req('plugins.listTools')).tools, []);
  assert.ok(!JSON.stringify(await req('status')).includes('private-token'));
});

test('QQ refuses changed account identity, self echoes and group events', async t => {
  const bot = await onebot(t), { req, events } = await setup(t);
  await assert.rejects(req('plugins.configure', { plugins: [{ ...config(bot.endpoint), expectedSelfId: 'wrong' }] }), { code: 'PLUGIN_START' });
  await req('plugins.configure', { plugins: [config(bot.endpoint)] });
  bot.push(incoming({ self_id: 'wrong' })); bot.push(incoming({ user_id: '123456' })); bot.push(incoming({ message_type: 'group', group_id: '123' }));
  await wait(35); assert.equal(events.filter(e => e.event === 'inbox').length, 0);
});

test('optional allowlist is strict at ingress and dispatch, empty means deny all', async t => {
  const bot = await onebot(t), { req, events, permit } = await setup(t);
  await req('plugins.configure', { plugins: [{ ...config(bot.endpoint), allowlistEnabled: true }] });
  bot.push(incoming()); await wait(25); assert.equal(events.filter(e => e.event === 'inbox').length, 0);
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'no', policyRevision: 1, permit: permit() }), { code: 'FORBIDDEN' });
  await req('plugins.configure', { plugins: [{ ...config(bot.endpoint), allowlistEnabled: true, allowlist: ['456789'], policyRevision: 2 }] });
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'stale', policyRevision: 1, permit: permit() }), { code: 'STALE_CONFIG' });
  bot.push(incoming()); await until(() => events.some(e => e.event === 'inbox'));
});

test('a submitted QQ timeout is unknown, never retried, and explicit closed-unknown recovery quarantines plugin', async t => {
  const bot = await onebot(t, { reply: false }), { req, host, permit } = await setup(t);
  await req('plugins.configure', { plugins: [config(bot.endpoint)] });
  const p = permit();
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'once', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(bot.calls.filter(c => c.action === 'send_private_msg').length, 1);
  assert.equal(host.receipts.find(r => r.commandId === p.commandId).status, 'unknown');
  const health = await req('channels.health', { pluginId: 'momo-qq' }); assert.equal(health.executorQuiescent, true);
  const resolution = await req('commands.reconcile', { commandId: p.commandId, status: 'closed_unknown' });
  assert.equal(resolution.receipt.deliveryStatus, 'unknown');
  await req('revoke', { activityEpoch: 2 }); await req('grant', { activityEpoch: 2 });
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'not until resumed', policyRevision: 1, permit: permit() }), { code: 'PLUGIN_UNAVAILABLE' });
});

test('WeChat gateway requires verified ordinary personal identity and pinned peers, then records client observation without claiming delivery', async t => {
  const sent = [], server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer wx-private');
    let body = ''; for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/health') response.end(JSON.stringify({ status: 'connected', actualSelfId: 'wxid_momo', identityKind: 'personal', identityVerified: true, executorQuiescent: true, capabilities: { receive: true, reply: true }, peers: [{ peerId: 'wxid_player', verified: true }] }));
    else if (request.url.startsWith('/v1/inbox')) response.end(JSON.stringify({ events: [], cursor: '0' }));
    else if (request.url === '/v1/send') { sent.push(JSON.parse(body)); response.end(JSON.stringify({ commandId: sent.at(-1).commandId, peerId: 'wxid_player', actualSelfId: 'wxid_momo', status: 'client_observed', executorQuiescent: true })); }
    else if (request.url === '/v1/stop') response.end(JSON.stringify({ executorQuiescent: true }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const { req, permit } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'momo-wechat', type: 'wechat', endpoint: `http://127.0.0.1:${server.address().port}`, accountId: 'wx-main', expectedSelfId: 'wxid_momo', credential: { token: 'wx-private' }, permissions: { receive: true, reply: true }, policyRevision: 3, allowlistEnabled: false }] });
  await assert.rejects(req('channels.send', { pluginId: 'momo-wechat', accountId: 'wx-main', peerId: 'display name', text: 'wrong identity', policyRevision: 3, permit: permit() }), { code: 'PEER_UNVERIFIED' });
  const result = await req('channels.send', { pluginId: 'momo-wechat', accountId: 'wx-main', peerId: 'wxid_player', text: 'hi', policyRevision: 3, permit: permit() });
  assert.equal(result.receipt.status, 'completed'); assert.equal(result.receipt.deliveryStatus, 'client_observed'); assert.equal(sent.length, 1);
});

test('QQ late provider confirmation is preserved on original command after timeout', async t => {
  const bot = await onebot(t, { reply: false }), { req, host, permit } = await setup(t);
  await req('plugins.configure', { plugins: [config(bot.endpoint)] });
  const p = permit();
  await assert.rejects(req('channels.send', { pluginId: 'momo-qq', accountId: 'qq-main', peerId: '456789', text: 'late', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  const send = bot.calls.find(c => c.action === 'send_private_msg');
  bot.push({ echo: send.echo, status: 'ok', retcode: 0, data: { message_id: 88 } });
  await until(() => host.receipts.some(r => r.commandId === p.commandId && r.late));
  assert.equal(host.receipts.at(-1).deliveryStatus, 'provider_accepted');
  assert.equal(host.paused, true); assert.equal(host.unresolved.size, 0);
});

test('withdrawn plugin gates prevent retries of unacknowledged old inbox events', async t => {
  const bot = await onebot(t), { req, host, events } = await setup(t);
  await req('plugins.configure', { plugins: [config(bot.endpoint)], configurationRevision: 1 });
  bot.push(incoming()); await until(() => events.some(e => e.event === 'inbox'));
  let release; host.mutations = new Promise(resolve => { release = resolve; });
  const changed = req('plugins.configure', { plugins: [], configurationRevision: 2 });
  const before = events.filter(e => e.event === 'inbox').length;
  await wait(2100);
  assert.equal(events.filter(e => e.event === 'inbox').length, before);
  release(); await changed;
});

test('WeChat HTTP server failure after submission stays unknown, not a safe failure', async t => {
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume */ }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/health') response.end(JSON.stringify({ status: 'connected', actualSelfId: 'wxid_momo', identityKind: 'personal', identityVerified: true, executorQuiescent: true, capabilities: { receive: true, reply: true }, peers: [{ peerId: 'wxid_player', verified: true }] }));
    else if (request.url.startsWith('/v1/inbox')) response.end(JSON.stringify({ events: [], cursor: '0' }));
    else { response.statusCode = 500; response.end(JSON.stringify({ status: 'unknown', error: 'backend failed after action', executorQuiescent: true })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const { req, host, permit } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'momo-wechat', type: 'wechat', endpoint: `http://127.0.0.1:${server.address().port}`, accountId: 'wx-main', expectedSelfId: 'wxid_momo', credential: { token: 'wx-private' }, permissions: { receive: true, reply: true }, policyRevision: 1 }] });
  const p = permit();
  await assert.rejects(req('channels.send', { pluginId: 'momo-wechat', accountId: 'wx-main', peerId: 'wxid_player', text: 'once', policyRevision: 1, permit: p }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(host.receipts.find(receipt => receipt.commandId === p.commandId).status, 'unknown');
});

test('WeChat identity-only authorization cannot dispatch chat even when user reply permission is enabled', async t => {
  let sends = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume */ }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/health') response.end(JSON.stringify({ status: 'connected', actualSelfId: 'wxid_momo', identityKind: 'personal', identityVerified: true, executorQuiescent: true, capabilities: { receive: false, reply: false }, peers: [{ peerId: 'wxid_player', verified: true }] }));
    else { sends++; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const { req, permit } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'momo-wechat', type: 'wechat', endpoint: `http://127.0.0.1:${server.address().port}`, accountId: 'wx-main', expectedSelfId: 'wxid_momo', credential: { token: 'wx-private' }, permissions: { receive: true, reply: true }, policyRevision: 1 }] });
  await assert.rejects(req('channels.send', { pluginId: 'momo-wechat', accountId: 'wx-main', peerId: 'wxid_player', text: 'not allowed', policyRevision: 1, permit: permit() }), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(sends, 0);
});


test('denied WeChat pages are durably discarded across host restart and allowlist relaxation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'momo-cursor-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'cursors.json'); let stored = [ { selfId: 'wxid_momo', peerId: 'wxid_player', senderId: 'wxid_player', conversationKind: 'private', externalMessageId: 'wxax:momo:player:1', text: 'previously denied' } ], acks = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/health') response.end(JSON.stringify({ status: 'connected', actualSelfId: 'wxid_momo', identityKind: 'personal', identityVerified: true, executorQuiescent: true, capabilities: { receive: true, reply: true, durableAck: true }, peers: [{ peerId: 'wxid_player', verified: true }] }));
    else if (request.url.startsWith('/v1/inbox')) { const cursor = new URL(request.url, 'http://localhost').searchParams.get('cursor'); response.end(JSON.stringify({ events: cursor === '1' ? [] : stored, cursor: '1' })); }
    else if (request.url === '/v1/ack') { assert.equal(JSON.parse(body).cursor, '1'); acks++; stored = []; response.end('{"acknowledged":true}'); }
    else response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const cfg = { id: 'momo-wechat', type: 'wechat', endpoint: `http://127.0.0.1:${server.address().port}`, accountId: 'wx-main', expectedSelfId: 'wxid_momo', credential: { token: 'wx-private' }, permissions: { receive: true, reply: true }, policyRevision: 1, allowlistEnabled: true, allowlist: [], pollMs: 100 };
  const denied = await setup(t, { channelStatePath: statePath }); await denied.req('plugins.configure', { plugins: [cfg] });
  await wait(80); assert.equal(denied.events.filter(e => e.event === 'inbox').length, 0);
  assert.ok(acks > 0, 'all-denied page must be durably ACKed'); assert.equal(stored.length, 0);
  assert.ok(!(await readFile(statePath, 'utf8')).includes('previously denied'));
  await denied.host.close();
  // Simulate a legacy / backed-up gateway keeping the old body: persisted cursor still fences it.
  stored = [{ selfId: 'wxid_momo', peerId: 'wxid_player', senderId: 'wxid_player', conversationKind: 'private', externalMessageId: 'wxax:momo:player:1', text: 'previously denied' }];
  const resumed = await setup(t, { channelStatePath: statePath }); await resumed.req('plugins.configure', { plugins: [{ ...cfg, policyRevision: 2, allowlistEnabled: false }] });
  await wait(150); assert.equal(resumed.events.filter(e => e.event === 'inbox').length, 0);
});

test('fenced WeChat gateway needs a fresh bridge generation after host revoke', async t => {
  let generation = 0, granted = false;
  const sends = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/health') response.end(JSON.stringify({ status: 'connected', actualSelfId: 'wxid_momo', identityKind: 'personal', identityVerified: true, executorQuiescent: true, executionGeneration: granted ? generation : null, capabilities: { receive: true, reply: true, executionFence: true }, peers: [{ peerId: 'wxid_player', verified: true }] }));
    else if (request.url.startsWith('/v1/inbox')) response.end('{"events":[],"cursor":"0"}');
    else if (request.url === '/v1/grant') { generation++; granted = true; response.end(JSON.stringify({ executionGeneration: generation, executorQuiescent: true })); }
    else if (request.url === '/v1/stop') { generation++; granted = false; response.end(JSON.stringify({ executionGeneration: generation, executorQuiescent: true })); }
    else if (request.url === '/v1/send') {
      assert.equal(granted, true); assert.equal(input.executionGeneration, generation);
      sends.push(input.executionGeneration);
      response.end(JSON.stringify({ commandId: input.commandId, peerId: input.peerId, actualSelfId: 'wxid_momo', status: 'client_observed', executorQuiescent: true }));
    } else response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const { req, permit } = await setup(t);
  await req('plugins.configure', { plugins: [{ id: 'momo-wechat', type: 'wechat', endpoint: `http://127.0.0.1:${server.address().port}`, accountId: 'wx-main', expectedSelfId: 'wxid_momo', credential: { token: 'wx-private' }, permissions: { receive: true, reply: true }, policyRevision: 1 }] });
  const send = text => req('channels.send', { pluginId: 'momo-wechat', accountId: 'wx-main', peerId: 'wxid_player', text, policyRevision: 1, permit: permit() });
  assert.equal((await send('first')).receipt.status, 'completed');
  const stopped = await req('revoke', { activityEpoch: 2 }); assert.equal(stopped.stopped, true);
  await req('grant', { activityEpoch: 2 });
  assert.equal((await send('second')).receipt.status, 'completed');
  assert.deepEqual(sends, [1, 3]);
});
