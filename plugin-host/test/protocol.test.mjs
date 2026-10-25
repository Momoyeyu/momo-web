import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function child(t) {
  const processHandle = spawn(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [], pending = new Map();
  let stderr = '';
  processHandle.stderr.on('data', data => { stderr += data; });
  createInterface({ input: processHandle.stdout }).on('line', line => {
    const message = JSON.parse(line); messages.push(message);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  });
  t.after(() => { if (processHandle.exitCode === null) processHandle.kill('SIGKILL'); });
  const token = 'pipe-test-token-'.repeat(3);
  const req = (method, params = {}) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 7000);
    pending.set(id, message => { clearTimeout(timeout); message.ok ? resolve(message.result) : reject(Object.assign(new Error(message.error.message), { code: message.error.code })); });
    processHandle.stdin.write(`${JSON.stringify({ v: 1, id, token, method, params })}\n`);
  });
  return { processHandle, messages, req, token, stderr: () => stderr };
}

test('stdio EOF cancels the owned MCP child and host exits', { timeout: 10000 }, async t => {
  const { processHandle, req, token, stderr } = child(t);
  const { hostInstance } = await req('hello', { coreInstance: 'parent', token });
  await req('heartbeat', { activityEpoch: 1 });
  await req('plugins.configure', { plugins: [{ id: 'echo', type: 'mcp', transport: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))] }] });
  const { tools } = await req('plugins.listTools');
  assert.equal(tools.length, 2);
  const response = await req('plugins.callTool', { name: 'echo__echo', permit: { coreInstance: 'parent', hostInstance, activityEpoch: 1, runId: 'run', commandId: 'pid-check', expiresAt: Date.now() + 5000 } });
  const childPid = JSON.parse(response.result.content[0].text).pid;
  const exit = once(processHandle, 'exit');
  processHandle.stdin.end();
  const [code] = await exit;
  assert.equal(code, 0);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  assert.equal(stderr(), '');
});

test('independent watchdog stops ticks when parent remains alive but stops heartbeats', { timeout: 5000 }, async t => {
  const { processHandle, messages, req, token } = child(t);
  const { hostInstance } = await req('hello', { coreInstance: 'parent', token, heartbeatMs: 300 });
  await req('heartbeat', { activityEpoch: 1 });
  await req('plugins.configure', { plugins: [{ id: 'virtual', type: 'virtual' }] });
  await req('virtual.activityStart', { permit: { coreInstance: 'parent', hostInstance, activityEpoch: 1, runId: 'run', commandId: 'command', expiresAt: Date.now() + 5000 }, tickMs: 10 });
  await wait(600);
  const ticks = messages.filter(message => message.event === 'activity.tick').length;
  assert.ok(ticks > 0);
  await wait(200);
  assert.equal(messages.filter(message => message.event === 'activity.tick').length, ticks);
  assert.ok(messages.some(message => message.event === 'host.paused'));
  const exit = once(processHandle, 'exit');
  await req('shutdown');
  await exit;
});
