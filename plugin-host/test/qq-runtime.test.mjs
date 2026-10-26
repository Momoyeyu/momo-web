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

test('an idle runtime requires an explicit owner login action and never scans or launches at construction', async t => {
  const { runtime, children } = manager(t);
  assert.equal(runtime.status().status, 'idle');
  assert.equal(runtime.status().running, false);
  await assert.rejects(runtime.begin({ ownerAction: false }), { code: 'OWNER_ACTION_REQUIRED' });
  assert.equal(children.length, 0);
});

test('a prepared child uses correlated commands and exposes QR only in authenticated detail until expiry', async t => {
  let now = Date.now();
  const { runtime, children, states } = manager(t, { now: () => now });
  const detail = await runtime.begin({ ownerAction: true, expectedSelfId: '123456' });
  const child = children[0];
  assert.deepEqual(child.commands.map(command => command.method), ['prepare', 'connect', 'requestQr']);
  assert.ok(child.commands.every(command => command.params.attemptId === detail.attemptId));
  assert.equal(runtime.status().status, 'qr_pending');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr.dataUrl, QR);
  assert.ok(!JSON.stringify(runtime.status()).includes('base64'));
  assert.ok(!JSON.stringify(states).includes('base64'));
  now += 61000;
  assert.equal(runtime.status().status, 'expired');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
});

test('refresh preserves the engine but fences cancelled and late attempt events', async t => {
  const { runtime, children } = manager(t);
  const first = await runtime.begin({ ownerAction: true });
  const second = await runtime.refreshQR({ ownerAction: true });
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(children.length, 1);
  const child = children[0];
  child.ipc({ event: 'connected', data: { attemptId: first.attemptId, selfId: '999999' } });
  child.ipc({ event: 'qr', data: { attemptId: first.attemptId, dataUrl: QR, expiresAt: Date.now() + 60000 } });
  await tick();
  assert.equal(runtime.status().attemptId, second.attemptId);
  assert.equal(runtime.status().connected, false);
  await runtime.cancel();
  child.ipc({ event: 'connected', data: { attemptId: second.attemptId, selfId: '999999' } });
  assert.equal(runtime.status().status, 'cancelled');
  assert.equal(runtime.status({ authenticatedDetail: true }).qr, null);
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
  assert.equal(children.length, 1);
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
