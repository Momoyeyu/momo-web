import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';

const loaded = await import('../src/qq-runtime.mjs');
const QR = 'data:image/png;base64,iVBORw0KGgo=';
const tick = () => new Promise(resolve => setImmediate(resolve));

function childTransport({ handle, stubborn = false, exitOnStop = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.commands = []; child.signals = []; child.exitCode = null; child.signalCode = null;
  let closed = false;
  child.finish = () => { if (!closed) { closed = true; child.exitCode = 0; child.emit('exit', 0, null); child.emit('close', 0, null); } };
  child.kill = signal => { child.signals.push(signal); if (!stubborn) queueMicrotask(child.finish); return true; };
  child.ipc = value => child.stdout.write('MOMO_QQ_IPC ' + JSON.stringify(value) + '\n');
  child.reply = (command, result = {}) => child.ipc({ id: command.id, result: { attemptId: command.params.attemptId, ...result } });
  child.stdin = new Writable({ write(chunk, encoding, done) {
    for (const line of chunk.toString().trim().split('\n')) {
      const command = JSON.parse(line); child.commands.push(command);
      queueMicrotask(() => {
        if (handle?.(command, child) === true) return;
        if (command.method === 'requestQr') child.ipc({ event: 'qr', data: { attemptId: command.params.attemptId, dataUrl: QR, expiresAt: Date.now() + 60000 } });
        child.reply(command);
        if (command.method === 'stop' && exitOnStop) queueMicrotask(child.finish);
      });
    }
    done();
  } });
  return child;
}
function manager(t, options = {}, childOptions = {}) {
  assert.equal(typeof loaded.QQRuntimeManager, 'function', 'managed QQ lifecycle is implemented');
  const children = [], states = [];
  const runtime = new loaded.QQRuntimeManager({
    createTransport: async () => { const child = childTransport(childOptions); children.push(child); return child; },
    onState: state => states.push(state), requestTimeoutMs: 50, stopTimeoutMs: 20, ...options,
  });
  t.after(() => runtime.stop());
  return { runtime, children, states };
}

test('diagnostics contain only bounded current-attempt phases and never enter public status', async t => {
  const diagnostics = [];
  let now = Date.now();
  const { runtime, children, states } = manager(t, { onDiagnostic: value => diagnostics.push(value), now: () => now });
  const attempt = await runtime.begin({ ownerAction: true });
  const child = children[0];
  assert.deepEqual(diagnostics.map(value => value.phase), ['resource_begin', 'resource_ready', 'process_started']);
  assert.ok(diagnostics.every(value => value.attemptId === attempt.attemptId && value.elapsedMs === 0));
  const emit = data => child.ipc({ event: 'diagnostic', data: { attemptId: attempt.attemptId, phase: 'qr_scanned', elapsedMs: 12, ...data } });
  for (const invalid of [
    { phase: 'secret-session-value' }, { code: 'account-secret' }, { elapsedMs: -1 },
    { elapsedMs: 86400001 }, { elapsedMs: '12' }, { elapsedMs: null },
    { phase: 'qr_scanned', secret: 'private-account-or-qr' }, { attemptId: 'stale-attempt' },
  ]) emit(invalid);
  assert.equal(diagnostics.length, 3);
  emit({ code: 140022 });
  assert.deepEqual(diagnostics.at(-1), { attemptId: attempt.attemptId, phase: 'qr_scanned', elapsedMs: 12, code: 140022 });
  assert.ok(Object.isFrozen(diagnostics.at(-1)));
  for (let index = 0; index < 100; index++) emit({ elapsedMs: index });
  assert.equal(diagnostics.length, 64);
  assert.ok(!JSON.stringify(runtime.status({ authenticatedDetail: true })).includes('elapsedMs'));
  assert.ok(!JSON.stringify(states).includes('elapsedMs'));
  await runtime.cancel();
  emit({ elapsedMs: 200 });
  assert.equal(diagnostics.length, 64);
  now += 10;
  const next = await runtime.refreshQR({ ownerAction: true });
  assert.notEqual(next.attemptId, attempt.attemptId);
  const count = diagnostics.length;
  child.ipc({ event: 'diagnostic', data: { attemptId: next.attemptId, phase: 'qr_authenticated', elapsedMs: 20 } });
  children[1].ipc({ event: 'diagnostic', data: { attemptId: attempt.attemptId, phase: 'qr_authenticated', elapsedMs: 20 } });
  assert.equal(diagnostics.length, count, 'neither a stale generation nor a stale attempt is observable');
  children[1].ipc({ event: 'diagnostic', data: { attemptId: next.attemptId, phase: 'login_failure', elapsedMs: 20, code: -1 } });
  assert.equal(diagnostics.length, count + 1, 'a new attempt has its own finite diagnostic budget');
});

test('inbound and outbound diagnostics allow only finite phases with integer classification codes', async t => {
  const diagnostics=[];
  const {runtime,children}=manager(t,{onDiagnostic:value=>diagnostics.push(value)});
  const attempt=await runtime.begin({ownerAction:true});
  const phases=['inbound_batch','inbound_rejected','inbound_accepted','outbound_update'];
  for(const [index,phase] of phases.entries())children[0].ipc({event:'diagnostic',data:{attemptId:attempt.attemptId,phase,elapsedMs:index,code:index}});
  assert.deepEqual(diagnostics.slice(-4).map(value=>value.phase),phases);
  assert.deepEqual(diagnostics.slice(-4).map(value=>value.code),[0,1,2,3]);
  const count=diagnostics.length;
  children[0].ipc({event:'diagnostic',data:{attemptId:attempt.attemptId,phase:'inbound_rejected',elapsedMs:4,code:1,message:'private-text'}});
  children[0].ipc({event:'diagnostic',data:{attemptId:attempt.attemptId,phase:'inbound_rejected',elapsedMs:4,code:'private-account'}});
  assert.equal(diagnostics.length,count);
  assert.ok(!JSON.stringify(diagnostics).includes('private-'));
});

test('throwing or asynchronously failing diagnostic observers cannot change authentication ownership', async t => {
  let callbacks = 0;
  const { runtime, children } = manager(t, { onDiagnostic: () => {
    callbacks++;
    if (callbacks % 2) throw new Error('private observer failure');
    return Promise.reject(new Error('private asynchronous observer failure'));
  } });
  const attempt = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  children[0].ipc({ event: 'diagnostic', data: { attemptId: attempt.attemptId, phase: 'qr_authenticated', elapsedMs: 10 } });
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  await tick();
  assert.equal(runtime.status().connected, true);
  assert.equal(runtime.status().actualSelfId, '123456');
  assert.equal(callbacks, 4);
});

test('a stalled request records only the finite timeout phase before revoking the attempt', async t => {
  const diagnostics = [];
  const { runtime } = manager(t, { onDiagnostic: value => diagnostics.push(value), requestTimeoutMs: 10 }, { handle(command) { return command.method === 'connect'; } });
  await assert.rejects(runtime.begin({ ownerAction: true }), { code: 'RUNTIME_TIMEOUT' });
  assert.equal(diagnostics.at(-1).phase, 'request_timeout');
  assert.equal(Object.keys(diagnostics.at(-1)).sort().join(','), 'attemptId,elapsedMs,phase');
  assert.equal(runtime.status().attemptId, null);
});

test('an idle runtime requires an explicit owner login action and never scans or launches at construction', async t => {
  const { runtime, children } = manager(t);
  assert.equal(runtime.status().status, 'idle');
  assert.equal(runtime.status().running, false);
  await assert.rejects(runtime.begin({ ownerAction: false }), { code: 'OWNER_ACTION_REQUIRED' });
  assert.equal(children.length, 0);
});

const restoreInput = (runtime, overrides = {}) => {
  const snapshot = runtime.status({ restoreDetail: true });
  return { ownerAction: true, expectedSelfId: '123456', expectedAttemptId: snapshot.attemptId, expectedLoginRevision: snapshot.loginRevision, ...overrides };
};

test('background restore uses a private revision snapshot and starts one bound cached-login attempt', async t => {
  const { runtime, children, states } = manager(t);
  assert.equal(runtime.status({ restoreDetail: true }).loginRevision, 0);
  assert.equal(runtime.status().loginRevision, undefined);
  assert.equal(runtime.status({ authenticatedDetail: true }).loginRevision, undefined);
  const restored = await runtime.restore(restoreInput(runtime));
  assert.equal(restored.loginRevision, 1);
  assert.equal(restored.attemptId, runtime.status().attemptId);
  assert.equal(restored.status, 'qr_pending');
  assert.deepEqual(children[0].commands[0].params, { attemptId: restored.attemptId, expectedSelfId: '123456', restoreSession: true });
  assert.ok(states.every(state => state.loginRevision === undefined));
});

test('background restore validates owner intent, identity, attempt and revision without side effects', async t => {
  const { runtime, children } = manager(t);
  const initial = restoreInput(runtime);
  await assert.rejects(async () => runtime.restore({ ...initial, ownerAction: false }), { code: 'OWNER_ACTION_REQUIRED' });
  for (const invalid of [
    { expectedSelfId: undefined }, { expectedSelfId: null }, { expectedSelfId: '' }, { expectedSelfId: 'not-qq' },
    { expectedAttemptId: undefined }, { expectedAttemptId: '' }, { expectedAttemptId: 'old-attempt' },
    { expectedLoginRevision: undefined }, { expectedLoginRevision: -1 }, { expectedLoginRevision: 0.5 },
    { expectedLoginRevision: '0' }, { expectedLoginRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) await assert.rejects(async () => runtime.restore({ ...initial, ...invalid }), { code: 'INPUT' });
  assert.deepEqual(restoreInput(runtime), initial);
  assert.equal(children.length, 0);
});

for (const action of ['cancel', 'stop']) {
  test(`an owner ${action} invalidates a background snapshot even when both attempt IDs are null`, async t => {
    const { runtime, children } = manager(t);
    const initial = restoreInput(runtime);
    await runtime[action]();
    const afterControl = runtime.status({ restoreDetail: true });
    assert.equal(afterControl.attemptId, null);
    assert.equal(afterControl.loginRevision, 1);
    await assert.rejects(async () => runtime.restore(initial), { code: 'ATTEMPT_CANCELLED' });
    assert.deepEqual(runtime.status({ restoreDetail: true }), afterControl);
    assert.equal(children.length, 0);
  });
}

test('a stale restore cannot cancel or replace a fresh owner QR attempt', async t => {
  const { runtime, children } = manager(t);
  await runtime.begin({ ownerAction: true });
  const snapshot = restoreInput(runtime);
  await runtime.refreshQR({ ownerAction: true });
  const current = runtime.status({ authenticatedDetail: true, restoreDetail: true });
  const commandCount = children[1].commands.length;
  await assert.rejects(async () => runtime.restore(snapshot), { code: 'ATTEMPT_CANCELLED' });
  assert.deepEqual(runtime.status({ authenticatedDetail: true, restoreDetail: true }), current);
  assert.equal(children[1].commands.length, commandCount);
  assert.equal(children.length, 2);
});

test('background restore refuses a current pending QR or verification without revoking its ownership', async t => {
  const { runtime, children } = manager(t);
  const attempt = await runtime.begin({ ownerAction: true });
  for (const status of ['qr_pending', 'awaiting_confirmation', 'verifying']) {
    children[0].ipc({ event: 'state', data: { attemptId: attempt.attemptId, status } });
    const current = runtime.status({ authenticatedDetail: true, restoreDetail: true });
    const commandCount = children[0].commands.length;
    await assert.rejects(async () => runtime.restore(restoreInput(runtime)), { code: 'RUNTIME_NOT_QUIESCENT' });
    assert.deepEqual(runtime.status({ authenticatedDetail: true, restoreDetail: true }), current);
    assert.equal(children[0].commands.length, commandCount);
  }
});

test('simultaneous background restores reserve one revision before asynchronous resource preparation', async t => {
  let finishTransport;
  const transport = new Promise(resolve => { finishTransport = resolve; });
  const { runtime } = manager(t, { createTransport: () => transport });
  const snapshot = restoreInput(runtime);
  const first = runtime.restore(snapshot);
  await assert.rejects(async () => runtime.restore(snapshot), { code: 'ATTEMPT_CANCELLED' });
  const pending = runtime.status({ restoreDetail: true });
  assert.equal(pending.status, 'preparing');
  assert.equal(pending.loginRevision, 1);
  await assert.rejects(async () => runtime.restore(restoreInput(runtime)), { code: 'RUNTIME_NOT_QUIESCENT' });
  assert.deepEqual(runtime.status({ restoreDetail: true }), pending);
  finishTransport(childTransport());
  const restored = await first;
  assert.equal(restored.loginRevision, 1);
  assert.equal(restored.attemptId, pending.attemptId);
});

test('owner stop during accepted background restoration fences and reaps its late child', async t => {
  let finishTransport;
  const transport = new Promise(resolve => { finishTransport = resolve; });
  const { runtime } = manager(t, { createTransport: () => transport });
  const restoring = runtime.restore(restoreInput(runtime));
  const rejected = assert.rejects(restoring, { code: 'RUNTIME_STOPPED' });
  await runtime.stop();
  const stoppedRevision = runtime.status({ restoreDetail: true }).loginRevision;
  const child = childTransport();
  finishTransport(child);
  await rejected;
  for (let index = 0; index < 20 && runtime.status().running; index++) await tick();
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().attemptId, null);
  assert.ok(runtime.status({ restoreDetail: true }).loginRevision >= stoppedRevision, 'late-child cleanup never restores the cancelled revision');
  assert.equal(child.exitCode, 0);
  assert.deepEqual(child.commands.map(command => command.method), ['stop']);
});

test('background restore does not interrupt forgetting or an unquiescent native process', async t => {
  let finishForget;
  const forgetting = new Promise(resolve => { finishForget = resolve; });
  const { runtime, children } = manager(t, { forgetSession: () => forgetting });
  const forgotten = runtime.forget({ ownerAction: true });
  await tick();
  const snapshot = restoreInput(runtime);
  await assert.rejects(async () => runtime.restore(snapshot), { code: 'RUNTIME_NOT_QUIESCENT' });
  assert.deepEqual(restoreInput(runtime), snapshot);
  assert.equal(children.length, 0);
  finishForget(); await forgotten;

  const other = manager(t, {}, { stubborn: true, exitOnStop: false });
  await other.runtime.begin({ ownerAction: true });
  await other.runtime.stop();
  const stopped = other.runtime.status({ restoreDetail: true });
  await assert.rejects(async () => other.runtime.restore(restoreInput(other.runtime)), { code: 'RUNTIME_NOT_QUIESCENT' });
  assert.deepEqual(other.runtime.status({ restoreDetail: true }), stopped);
  assert.equal(other.children.length, 1);
  other.children[0].finish();
});

test('background restore can acknowledge an exact connected identity without changing the session', async t => {
  const { runtime, children } = manager(t);
  const attempt = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  const snapshot = restoreInput(runtime);
  const commandCount = children[0].commands.length;
  assert.equal((await runtime.restore(snapshot)).attemptId, attempt.attemptId);
  assert.equal((await runtime.restore(snapshot)).loginRevision, snapshot.expectedLoginRevision);
  await assert.rejects(async () => runtime.restore({ ...snapshot, expectedSelfId: '654321' }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(children[0].commands.length, commandCount);
  assert.equal(children.length, 1);
});

test('a prepared child uses correlated commands and exposes QR only in authenticated detail until expiry', async t => {
  let now = Date.now();
  const { runtime, children, states } = manager(t, { now: () => now });
  const detail = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  const child = children[0];
  assert.deepEqual(child.commands.map(command => command.method), ['prepare', 'connect', 'requestQr']);
  assert.deepEqual(child.commands[0].params, { attemptId: detail.attemptId, expectedSelfId: '123456', restoreSession: true });
  assert.ok(child.commands.every(command => command.params.attemptId === detail.attemptId));
  assert.equal(runtime.status().status, 'qr_pending');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr.dataUrl, QR);
  assert.ok(!JSON.stringify(runtime.status()).includes('base64'));
  assert.ok(!JSON.stringify(states).includes('base64'));
  now += 61000;
  assert.equal(runtime.status().status, 'expired');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
});

test('private cached-login verification is not overwritten by an artificial QR-pending state', async t => {
  const { runtime } = manager(t, {}, { handle(command, child) {
    if (command.method === 'connect') child.ipc({ event: 'state', data: { attemptId: command.params.attemptId, status: 'verifying' } });
    if (command.method === 'requestQr') { child.reply(command); return true; }
  } });
  await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(runtime.status().status, 'verifying');
});

test('cached restore can explicitly fall back to a visible QR without retaining its verification timeout', async t => {
  const { runtime, children } = manager(t, { phaseTimeoutMs: 20 }, { handle(command, child) {
    if (command.method === 'connect') child.ipc({ event: 'state', data: { attemptId: command.params.attemptId, status: 'verifying' } });
    if (command.method === 'requestQr') { child.reply(command); return true; }
  } });
  const attempt = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(runtime.status().status, 'verifying');
  children[0].ipc({ event: 'state', data: { attemptId: attempt.attemptId, status: 'qr_pending' } });
  children[0].ipc({ event: 'qr', data: { attemptId: attempt.attemptId, dataUrl: QR, expiresAt: Date.now() + 60000 } });
  assert.equal(runtime.status().status, 'qr_pending');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr.dataUrl, QR);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(runtime.status().status, 'qr_pending');
  assert.equal(runtime.status().running, true);
});

test('native authentication is monotonic within an attempt and does not leak into a replacement attempt', async t => {
  const { runtime, children } = manager(t);
  const first = await runtime.begin({ ownerAction: true });
  const child = children[0];
  child.ipc({ event: 'state', data: { attemptId: first.attemptId, status: 'verifying', authenticated: true } });
  child.ipc({ event: 'state', data: { attemptId: first.attemptId, status: 'verifying', authenticated: false } });
  child.ipc({ event: 'state', data: { attemptId: first.attemptId, status: 'qr_pending' } });
  assert.equal(runtime.status().status, 'verifying');
  assert.ok(!JSON.stringify(runtime.status({ authenticatedDetail: true })).includes('authenticated'));
  const second = await runtime.refreshQR({ ownerAction: true });
  children[1].ipc({ event: 'state', data: { attemptId: second.attemptId, status: 'verifying' } });
  children[1].ipc({ event: 'state', data: { attemptId: second.attemptId, status: 'qr_pending' } });
  children[1].ipc({ event: 'qr', data: { attemptId: second.attemptId, dataUrl: QR, expiresAt: Date.now() + 60000 } });
  assert.equal(runtime.status().status, 'qr_pending');
  assert.ok(runtime.status({ authenticatedDetail: true }).qr);
});

test('an acknowledged QR request without a callback times out and reaps the unauthenticated process', async t => {
  const { runtime, children } = manager(t, { phaseTimeoutMs: 20 }, { handle(command, child) {
    if (command.method === 'requestQr') { child.reply(command); return true; }
  } });
  const attempt = await runtime.begin({ ownerAction: true });
  for (let i = 0; i < 100 && (runtime.status().running || !runtime.status().error); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.status().error, 'RUNTIME_TIMEOUT');
  assert.equal(runtime.status().running, false);
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  assert.equal(runtime.status().connected, false);
});

test('a worker account mismatch retains its safe actionable identity state', async t => {
  const {runtime,children}=manager(t);
  const attempt=await runtime.begin({ownerAction:true,expectedSelfId:'123456'});
  children[0].ipc({event:'state',data:{attemptId:attempt.attemptId,status:'error',code:'ACCOUNT_MISMATCH'}});
  assert.equal(runtime.status().status,'identity_mismatch');
  assert.equal(runtime.status().error,'ACCOUNT_MISMATCH');
  assert.equal(runtime.status({authenticatedDetail:true}).qr,null);
});

test('verification has a deadline while an available unexpired QR remains available for user scanning', async t => {
  const { runtime, children } = manager(t, { phaseTimeoutMs: 20 });
  const attempt = await runtime.begin({ ownerAction: true });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(runtime.status().status, 'qr_pending');
  assert.ok(runtime.status({ authenticatedDetail: true }).qr);
  children[0].ipc({ event: 'state', data: { attemptId: attempt.attemptId, status: 'verifying', authenticated: true } });
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  children[0].ipc({ event: 'qr', data: { attemptId: attempt.attemptId, dataUrl: QR, expiresAt: Date.now() + 60000 } });
  assert.equal(runtime.status().status, 'verifying', 'a delayed QR callback cannot reset session verification');
  for (let i = 0; i < 100 && (runtime.status().running || !runtime.status().error); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(runtime.status().error, 'RUNTIME_TIMEOUT');
  assert.equal(runtime.status().running, false);
});

for (const delayedStatus of ['qr_pending', 'awaiting_confirmation']) {
  test(`a delayed ${delayedStatus} callback cannot demote verification or remove its deadline`, async t => {
    const { runtime, children } = manager(t, { phaseTimeoutMs: 20 });
    const attempt = await runtime.begin({ ownerAction: true });
    const child = children[0];
    child.ipc({ event: 'state', data: { attemptId: attempt.attemptId, status: 'verifying', authenticated: true } });
    child.ipc({ event: 'state', data: { attemptId: attempt.attemptId, status: delayedStatus } });
    child.ipc({ event: 'qr', data: { attemptId: attempt.attemptId, dataUrl: QR, expiresAt: Date.now() + 60000 } });
    assert.equal(runtime.status().status, 'verifying');
    assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
    for (let index = 0; index < 100 && (runtime.status().running || !runtime.status().error); index++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.status().error, 'RUNTIME_TIMEOUT');
    assert.equal(runtime.status().running, false, 'the original verification deadline still reaps a stalled session');
  });
}

test('refresh reaps the previous native callback source before creating a new attempt', async t => {
  const { runtime, children } = manager(t);
  const first = await runtime.begin({ ownerAction: true });
  const second = await runtime.refreshQR({ ownerAction: true });
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(children.length, 2);
  assert.ok(children[0].commands.some(command => command.method === 'stop'));
  assert.equal(children[0].exitCode, 0);
  const child = children[0];
  child.ipc({ event: 'connected', data: { attemptId: first.attemptId, selfId: '999999' } });
  child.ipc({ event: 'qr', data: { attemptId: first.attemptId, dataUrl: QR, expiresAt: Date.now() + 60000 } });
  await tick();
  assert.equal(runtime.status().attemptId, second.attemptId);
  assert.equal(runtime.status().connected, false);
  await runtime.cancel();
  children[1].ipc({ event: 'connected', data: { attemptId: second.attemptId, selfId: '999999' } });
  assert.equal(runtime.status().status, 'cancelled');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
});

test('a QR refresh skips cached restore in a new owned process and preserves the pinned identity', async t => {
  const { runtime, children } = manager(t);
  const first = await runtime.begin({ ownerAction: true, expectedSelfId: '123456', restoreSession: false });
  assert.deepEqual(children[0].commands[0].params, { attemptId: first.attemptId, expectedSelfId: '123456', restoreSession: true }, 'public callers cannot disable ordinary cached session restoration');
  const second = await runtime.refreshQR({ ownerAction: true, expectedSelfId: '654321', restoreSession: true });
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(children.length, 2);
  assert.equal(children[0].exitCode, 0, 'the previous native callback generation must be reaped first');
  assert.deepEqual(children[1].commands[0].params, { attemptId: second.attemptId, expectedSelfId: '123456', restoreSession: false }, 'refresh bypasses a stalled cached restore without changing the pinned account');
  assert.deepEqual(children[1].commands.map(command => command.method), ['prepare', 'connect', 'requestQr']);
});

test('a concurrent refresh withdraws an in-flight attempt before its delayed response', async t => {
  let held;
  const { runtime, children } = manager(t, {}, { handle(command, child) {
    if (command.method === 'connect' && !held) { held = { command, child }; return true; }
  } });
  const first = runtime.begin({ ownerAction: true });
  const firstRejected = assert.rejects(first, { code: 'ATTEMPT_CANCELLED' });
  for (let i = 0; i < 20 && !held; i++) await tick();
  assert.ok(held);
  const latest = await runtime.refreshQR({ ownerAction: true });
  held.child.reply(held.command);
  await firstRejected;
  assert.equal(runtime.status().attemptId, latest.attemptId);
  assert.equal(children.length, 2);
});

test('an already verified login is idempotent and cannot silently switch accounts', async t => {
  const { runtime, children } = manager(t);
  const first = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  children[0].ipc({ event: 'connected', data: { attemptId: first.attemptId, selfId: '123456' } });
  assert.equal((await runtime.begin({ ownerAction: true, expectedSelfId: '123456' })).attemptId, first.attemptId);
  assert.equal((await runtime.refreshQR({ ownerAction: true })).connected, true);
  await assert.rejects(runtime.begin({ ownerAction: true, expectedSelfId: '654321' }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(children.length, 1);
  assert.equal(runtime.status().actualSelfId, '123456');
});

test('native channel dispatch requires verified identity and supports only fixed private-text actions', async t => {
  const { runtime, children } = manager(t);
  await assert.rejects(runtime.requestChannel('send_private_msg', { user_id: '654321', message: 'hello' }, 'send-1'), error => error.code === 'RUNTIME_STOPPED' && error.submitted === false);
  const attempt = await runtime.begin({ ownerAction: true });
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  await assert.rejects(runtime.requestChannel('delete_msg', {}, 'bad-1'), { code: 'INPUT' });
  await assert.rejects(runtime.requestChannel('send_private_msg', { user_id: '123456', message: 'self' }, 'bad-2'), { code: 'INPUT' });
  await runtime.requestChannel('send_private_msg', { user_id: '654321', message: 'hello', token: 'ignore' }, 'send-1');
  assert.deepEqual(children[0].commands.at(-1).params, { attemptId: attempt.attemptId, action: 'send_private_msg', params: { user_id: '654321', message: 'hello' }, echo: 'send-1' });
});

test('native channel receipts retain admitted echo correlation after cancellation without accepting new ingress', async t => {
  const { runtime, children } = manager(t), events = [];
  const unsubscribe = runtime.onNativeEvent(event => events.push(event));
  const attempt = await runtime.begin({ ownerAction: true });
  const child = children[0];
  child.ipc({ event: 'onebot', data: { echo: 'never-admitted', status: 'ok', retcode: 0, data: { message_id: 'fake' } } });
  child.ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  await runtime.requestChannel('send_private_msg', { user_id: '654321', message: 'hello' }, 'original-send');
  assert.equal(runtime.channelQuiescent(), false, 'a control ACK is not native send quiescence');
  await runtime.cancel();
  assert.equal(runtime.channelQuiescent(), false, 'cancel cannot retract an admitted native send');
  child.ipc({ event: 'onebot', data: { post_type: 'message', self_id: '123456', raw_message: 'blocked' } });
  child.ipc({ event: 'onebot', data: { echo: 'original-send', status: 'ok', retcode: 0, data: { message_id: 'actual' } } });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.message_id, 'actual');
  assert.equal(runtime.channelQuiescent(), true);
  child.ipc({ event: 'onebot', data: { echo: 'original-send', status: 'ok', retcode: 0, data: { message_id: 'duplicate' } } });
  assert.equal(events.length, 1);
  unsubscribe();
});

test('native process loss marks a dispatched send unknown and never invents a delivery fact', async t => {
  const { runtime, children } = manager(t, {}, { handle(command) { return command.method === 'onebot'; } }), events = [];
  runtime.onNativeEvent(event => events.push(event));
  const attempt = await runtime.begin({ ownerAction: true });
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  const sending = runtime.requestChannel('send_private_msg', { user_id: '654321', message: 'hello' }, 'lost-send');
  const rejected = assert.rejects(sending, error => error.submitted === true && error.code === 'RUNTIME_STOPPED');
  children[0].finish(); await rejected;
  assert.equal(events.length, 0);
});

test('connected requires the current attempt and expected QQ identity, never merely scanned state', async t => {
  const { runtime, children } = manager(t);
  const attempt = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  const child = children[0];
  child.ipc({ event: 'state', data: { attemptId: attempt.attemptId, status: 'awaiting_confirmation' } });
  assert.equal(runtime.status().connected, false);
  child.ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '654321', token: 'must-not-leak' } });
  assert.equal(runtime.status().status, 'identity_mismatch');
  assert.equal(runtime.status().connected, false);
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  child.ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  assert.equal(runtime.status().connected, false, 'a failed identity attempt remains revoked');
  assert.ok(!JSON.stringify(runtime.status()).includes('must-not-leak'));
});

test('a verified identity can connect without exposing native fields in status callbacks', async t => {
  const { runtime, children, states } = manager(t);
  const attempt = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456', nickname: 'momo', token: 'private-token', path: '/private/qq' } });
  assert.equal(runtime.status().connected, true);
  assert.equal(runtime.status().actualSelfId, '123456');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  assert.ok(!JSON.stringify(states).includes('private-token'));
  assert.ok(!JSON.stringify(states).includes('/private/qq'));
});

test('native stdout and stderr cannot become IPC or leak through process errors', async t => {
  const { runtime, children, states } = manager(t);
  const attempt = await runtime.begin({ ownerAction: true });
  const child = children[0];
  child.stdout.write(JSON.stringify({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } }) + '\n');
  child.stderr.write('credential secret-with-path /private/data\n');
  child.stdout.write('native chatter secret-with-path\nMOMO_QQ_IPC {malformed\n');
  assert.equal(runtime.status().connected, false);
  child.emit('error', new Error('secret-with-path /private/data'));
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  assert.equal(runtime.status().error, 'RUNTIME_FAILED');
  assert.ok(!JSON.stringify(states).includes('secret-with-path'));
});

test('a crashed engine revokes QR and cannot reconnect from later events or restart automatically', async t => {
  const { runtime, children } = manager(t);
  const attempt = await runtime.begin({ ownerAction: true });
  children[0].finish();
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  await tick();
  assert.equal(runtime.status().running, false);
  assert.equal(runtime.status().connected, false);
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  assert.equal(children.length, 1);
});

test('stop escalates only its owned child and forget waits for confirmed quiescence', async t => {
  let forgotten = 0;
  const { runtime, children } = manager(t, { forgetSession: async () => { forgotten++; } }, { exitOnStop: false });
  await runtime.begin({ ownerAction: true });
  await runtime.forget({ ownerAction: true });
  assert.equal(runtime.status().running, false);
  assert.equal(forgotten, 1);
  assert.deepEqual(children[0].signals, ['SIGTERM']);
});

test('logout requires fresh authentication across retries until a genuine connected identity arrives', async t => {
  const { runtime, children } = manager(t, { forgetSession: async () => {} });
  await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  await runtime.forget({ ownerAction: true });
  const first = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(children[1].commands.find(command => command.method === 'prepare').params.restoreSession, false);
  children[1].ipc({ event: 'state', data: { attemptId: first.attemptId, status: 'verifying', authenticated: true } });
  await runtime.stop();
  const second = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(children[2].commands.find(command => command.method === 'prepare').params.restoreSession, false,
    'a scanned or initialized session has not completed fresh authentication');
  children[2].ipc({ event: 'connected', data: { attemptId: first.attemptId, selfId: '123456' } });
  await runtime.stop();
  const third = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(children[3].commands.find(command => command.method === 'prepare').params.restoreSession, false,
    'a stale connected callback cannot permit cached restoration');
  children[3].ipc({ event: 'connected', data: { attemptId: third.attemptId, selfId: '123456' } });
  assert.equal(runtime.status().connected, true);
  await runtime.stop();
  await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(children[4].commands.find(command => command.method === 'prepare').params.restoreSession, true);
  assert.notEqual(first.attemptId, second.attemptId);
});

test('ordinary internal stop preserves cached-session restoration without forgetting credentials', async t => {
  let forgotten = 0;
  const { runtime, children } = manager(t, { forgetSession: async () => { forgotten++; } });
  await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  await runtime.stop();
  await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(children[1].commands.find(command => command.method === 'prepare').params.restoreSession, true);
  assert.equal(forgotten, 0);
});

test('failed credential removal is reported and cannot silently reuse the saved session', async t => {
  const { runtime, children } = manager(t, { forgetSession: async () => { throw new Error('private storage failure'); } });
  await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  await assert.rejects(runtime.forget({ ownerAction: true }), { code: 'FORGET_FAILED' });
  await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  assert.equal(children[1].commands.find(command => command.method === 'prepare').params.restoreSession, false);
});

test('an unkillable child blocks forgetting and refuses a replacement process', async t => {
  let forgotten = 0;
  const { runtime, children } = manager(t, { forgetSession: async () => { forgotten++; } }, { stubborn: true, exitOnStop: false });
  await runtime.begin({ ownerAction: true });
  await assert.rejects(runtime.forget({ ownerAction: true }), { code: 'RUNTIME_NOT_QUIESCENT' });
  assert.equal(forgotten, 0);
  await assert.rejects(runtime.begin({ ownerAction: true }), { code: 'RUNTIME_NOT_QUIESCENT' });
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].signals, ['SIGTERM', 'SIGKILL']);
  children[0].finish();
});

test('a request timeout is sanitized and withdraws the active QR attempt', async t => {
  const { runtime } = manager(t, {}, { handle(command) { return command.method === 'requestQr'; } });
  await assert.rejects(runtime.begin({ ownerAction: true }), { code: 'RUNTIME_TIMEOUT' });
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  assert.equal(runtime.status().connected, false);
});

test('oversized prefixed IPC is bounded and revokes login instead of accepting truncated frames', async t => {
  const { runtime, children } = manager(t, { maxFrameBytes: 1024 });
  const attempt = await runtime.begin({ ownerAction: true });
  children[0].stdout.write('native ' + 'x'.repeat(4096) + '\n');
  assert.equal(runtime.status().status, 'qr_pending');
  children[0].stdout.write('MOMO_QQ_IPC ' + JSON.stringify({ event: 'state', data: { attemptId: attempt.attemptId, status: 'verifying', secret: 'x'.repeat(4096) } }) + '\n');
  assert.equal(runtime.status().error, 'IPC_LIMIT');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
});

test('the production path fails closed without prequalified resources or with a generic client executable', async t => {
  assert.equal(typeof loaded.QQRuntimeManager, 'function', 'managed QQ lifecycle is implemented');
  const unavailable = new loaded.QQRuntimeManager();
  t.after(() => unavailable.stop());
  await assert.rejects(unavailable.begin({ ownerAction: true }), { code: 'RESOURCE_UNAVAILABLE' });
  const arbitrary = new loaded.QQRuntimeManager({ prepareInvocation: async () => ({ command: process.execPath, args: ['--version'], cwd: process.cwd(), env: {} }) });
  t.after(() => arbitrary.stop());
  await assert.rejects(arbitrary.begin({ ownerAction: true }), { code: 'RESOURCE_INVALID' });
});

test('the manager owns a real child over newline stdin and prefixed stdout, then reaps it', async t => {
  assert.equal(typeof loaded.QQRuntimeManager, 'function', 'managed QQ lifecycle is implemented');
  let child;
  const script = `import readline from 'node:readline';
    const output = value => process.stdout.write('MOMO_QQ_IPC ' + JSON.stringify(value) + '\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const {id,method,params} = JSON.parse(line);
      process.stdout.write('QQ native diagnostic credential-do-not-forward\\n');
      if (method === 'requestQr') output({event:'qr',data:{attemptId:params.attemptId,dataUrl:'${QR}',expiresAt:Date.now()+60000}});
      output({id,result:{attemptId:params.attemptId}});
      if (method === 'stop') process.exit(0);
    });`;
  const runtime = new loaded.QQRuntimeManager({ createTransport: () => (child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })), requestTimeoutMs: 1000, stopTimeoutMs: 100 });
  t.after(() => runtime.stop());
  await runtime.begin({ ownerAction: true });
  assert.equal(runtime.status({ authenticatedDetail: true }).qr.dataUrl, QR);
  const pid = child.pid;
  const result = await runtime.stop();
  assert.equal(result.executorQuiescent, true);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('a terminal runtime state revokes the attempt so delayed success cannot reconnect it', async t => {
  const { runtime, children } = manager(t);
  const attempt = await runtime.begin({ ownerAction: true });
  children[0].ipc({ event: 'state', data: { attemptId: attempt.attemptId, status: 'error', code: 'secret-raw-native-error' } });
  children[0].ipc({ event: 'connected', data: { attemptId: attempt.attemptId, selfId: '123456' } });
  assert.equal(runtime.status().connected, false);
  assert.equal(runtime.status().error, 'RUNTIME_FAILED');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
});

test('an oversized IPC prefix split across chunks still revokes the attempt', async t => {
  const { runtime, children } = manager(t, { maxFrameBytes: 1024 });
  await runtime.begin({ ownerAction: true });
  children[0].stdout.write('MOMO_');
  children[0].stdout.write('QQ_IPC ' + 'x'.repeat(4096));
  assert.equal(runtime.status().error, 'IPC_LIMIT');
});

test('stop is bounded during resource preparation and later completion cannot launch a child', async t => {
  let finishPreparation;
  const prepared = new Promise(resolve => { finishPreparation = resolve; });
  const { runtime, children } = manager(t, { prepareInvocation: () => prepared });
  const beginning = runtime.begin({ ownerAction: true });
  const rejected = assert.rejects(beginning, { code: 'RUNTIME_STOPPED' });
  const result = await runtime.stop();
  assert.equal(result.executorQuiescent, false);
  finishPreparation({});
  await rejected;
  await tick();
  assert.equal(children.length, 0);
  assert.equal(runtime.status().executorQuiescent, true);
});

test('a child returned after a bounded stop is fenced and reaped before forgetting is allowed', async t => {
  let finishTransport, forgotten = 0;
  const late = new Promise(resolve => { finishTransport = resolve; });
  const { runtime } = manager(t, { createTransport: () => late, forgetSession: async () => { forgotten++; } });
  const beginning = runtime.begin({ ownerAction: true });
  const rejected = assert.rejects(beginning, { code: 'RUNTIME_STOPPED' });
  const stopped = await runtime.stop();
  assert.equal(stopped.executorQuiescent, false);
  const child = childTransport();
  finishTransport(child);
  await rejected;
  for (let i = 0; i < 20 && runtime.status().running; i++) await tick();
  assert.equal(runtime.status().running, false);
  await runtime.forget({ ownerAction: true });
  assert.equal(forgotten, 1);
});

test('parent exit does not permit forgetting while its owned descendant tree remains live', async t => {
  let treeAlive = true, forgotten = 0;
  const child = childTransport({ exitOnStop: true });
  const signals = [];
  const { runtime } = manager(t, {
    createTransport: () => ({ child, isTreeStopped: () => !treeAlive, killTree: signal => { signals.push(signal); if (signal === 'SIGKILL') treeAlive = false; } }),
    forgetSession: async () => { assert.equal(treeAlive, false); forgotten++; },
  });
  await runtime.begin({ ownerAction: true });
  child.finish();
  assert.equal(runtime.status().executorQuiescent, false);
  await runtime.forget({ ownerAction: true });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(forgotten, 1);
});

test('a real owned process group is reaped after the parent exits while its descendant holds stdout', async t => {
  assert.equal(typeof loaded.QQRuntimeManager, 'function');
  let child, descendantPid, parentExited = false, forgotten = 0;
  const signals = [];
  const groupStopped = () => {
    if (!child?.pid) return true;
    try { process.kill(-child.pid, 0); return false; } catch (cause) { return cause.code === 'ESRCH'; }
  };
  const descendant = `process.on('SIGTERM',()=>{}); process.stdout.write('DESCENDANT_READY '+process.pid+'\\n'); setInterval(()=>{},1000);`;
  const script = `import {spawn} from 'node:child_process'; import readline from 'node:readline';
    spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit']});
    const output=value=>process.stdout.write('MOMO_QQ_IPC '+JSON.stringify(value)+'\\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{const {id,method,params}=JSON.parse(line);
      if(method==='requestQr')output({event:'qr',data:{attemptId:params.attemptId,dataUrl:'${QR}',expiresAt:Date.now()+60000}});
      output({id,result:{attemptId:params.attemptId}}); if(method==='stop')process.exit(0);
    });`;
  const runtime = new loaded.QQRuntimeManager({
    createTransport: () => {
      child = spawn(process.execPath, ['--input-type=module', '-e', script], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let native = '';
      child.stdout.on('data', chunk => { native += chunk.toString(); const match = /DESCENDANT_READY (\d+)/.exec(native); if (match) descendantPid = Number(match[1]); });
      child.once('exit', () => { parentExited = true; });
      return { child, isTreeStopped: groupStopped, killTree: signal => { signals.push(signal); try { process.kill(-child.pid, signal); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; } } };
    },
    forgetSession: async () => { assert.equal(parentExited, true); assert.equal(groupStopped(), true); forgotten++; },
    requestTimeoutMs: 1000, stopTimeoutMs: 200,
  });
  t.after(async () => { if (!groupStopped()) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } await runtime.stop(); });
  await runtime.begin({ ownerAction: true });
  for (let i = 0; i < 100 && !descendantPid; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(descendantPid, 'the real descendant initialized before stop');
  await runtime.forget({ ownerAction: true });
  assert.equal(forgotten, 1);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
});

test('resource qualification failures retain a safe actionable code without native paths or diagnostics', async t => {
  const { runtime, states, children } = manager(t, { prepareInvocation: async () => { const cause = new Error('/private/resources/secret-session'); cause.code = 'RESOURCE_INVALID'; throw cause; } });
  await assert.rejects(runtime.begin({ ownerAction: true }), cause => {
    assert.equal(cause.code, 'RESOURCE_INVALID');
    assert.ok(!cause.message.includes('/private'));
    return true;
  });
  assert.equal(children.length, 0);
  assert.equal(runtime.status().error, 'RESOURCE_INVALID');
  assert.ok(!JSON.stringify(states).includes('secret-session'));
});

const nonStringCodes = [
  ['object', { toString: null, valueOf: null }],
  ['array', ['RESOURCE_INVALID']],
  ['null', null],
  ['number', 17],
];
for (const [kind, code] of nonStringCodes) {
  test(`malformed ${kind} IPC error code cannot escape the stream handler or leave login unsettled`, async t => {
    let escaped;
    const { runtime } = manager(t, {}, { handle(command, child) {
      if (command.method !== 'prepare') return;
      try { child.ipc({ id: command.id, error: { code } }); } catch (cause) { escaped = cause; }
      return true;
    } });
    let timer;
    const outcome = await Promise.race([
      runtime.begin({ ownerAction: true }).then(() => ({ resolved: true }), cause => ({ code: cause.code })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ unsettled: true }), 150); }),
    ]);
    clearTimeout(timer);
    assert.equal(escaped, undefined, 'malformed IPC never throws out of stdout processing');
    assert.deepEqual(outcome, { code: 'IPC_PROTOCOL' }, 'the pending request rejects instead of losing its timer and resolver');
    assert.equal(runtime.status().error, 'IPC_PROTOCOL');
    assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  });
  test(`a ${kind} error code is never coerced into an allowed resource error`, async t => {
    assert.doesNotThrow(() => new loaded.QQRuntimeError(code));
    assert.equal(new loaded.QQRuntimeError(code).code, 'RUNTIME_FAILED');
    const { runtime } = manager(t, { prepareInvocation: async () => { throw { code }; } });
    await assert.rejects(runtime.begin({ ownerAction: true }), { code: 'RUNTIME_FAILED' });
    assert.equal(runtime.status().error, 'RUNTIME_FAILED');
  });
}
for (const [kind, malformedError] of [['array', []], ['string', 'RESOURCE_INVALID'], ['null', null], ['boolean', false]]) {
  test(`a correlated ${kind} error response rejects as invalid IPC`, async t => {
    const { runtime } = manager(t, {}, { handle(command, child) {
      if (command.method !== 'prepare') return;
      child.ipc({ id: command.id, error: malformedError });
      return true;
    } });
    await assert.rejects(runtime.begin({ ownerAction: true }), { code: 'IPC_PROTOCOL' });
    assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
  });
}

test('process exit diagnostics retain only the numeric cause before the attempt is revoked', async t => {
  const diagnostics=[];const {runtime,children}=manager(t,{onDiagnostic:value=>diagnostics.push(value)});
  const attempt=await runtime.begin({ownerAction:true});
  children[0].emit('exit',null,'SIGABRT');await tick();
  assert.deepEqual(diagnostics.at(-1),{attemptId:attempt.attemptId,phase:'process_exit',elapsedMs:diagnostics.at(-1).elapsedMs,code:-6});
  assert.equal(runtime.status().connected,false);
});
