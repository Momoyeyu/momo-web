import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PluginHost, HostError } from '../src/host.mjs';
import { QQRuntimeError } from '../src/qq-runtime.mjs';

const token = 'managed-runtime-host-test-'.repeat(2);
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
