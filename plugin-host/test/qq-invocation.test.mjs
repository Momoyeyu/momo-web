import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, realpath, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const module = await import('../src/qq-invocation.mjs').catch(() => ({}));
const roles = { runtime: 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A/QQNT', major: 'QQRuntime.app/Contents/Resources/app/major.node', wrapper: 'QQRuntime.app/Contents/Resources/app/wrapper.node', bootstrap: 'QQRuntime.app/Contents/MacOS/MomoQQRuntime', worker: 'control/worker.cjs', profile: 'control/isolation.sb', metadata: 'control/metadata.json' };
const pins = { resourceId: 'momo-qq-fixture', version: 'fixture-1', platform: 'darwin', architecture: 'arm64', nativeABI: { electron: '37.1.0', node: '22.16.0', modules: '136', napi: '10' }, qq: { version: '6.9.95', buildVersion: '48517' } };
async function fixture(t) {
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), 'momo-qq-invocation-')));
  await chmod(privateRoot, 0o700); t.after(() => rm(privateRoot, { recursive: true, force: true }));
  const resourceRoot = join(privateRoot, 'resources'), dataRoot = join(privateRoot, 'session'), controlRoot = join(privateRoot, 'control'), canaryPath = join(privateRoot, 'denied-canary.txt'), manifestPath = join(privateRoot, 'pins.json');
  for (const path of [resourceRoot, dataRoot, controlRoot]) await mkdir(path, { mode: 0o700 });
  await writeFile(canaryPath, 'synthetic unreadable canary', { mode: 0o600 });
  const contents = Object.entries(roles).map(([role, path]) => [path, role === 'metadata' ? JSON.stringify(pins) : `inert ${role}\n`]);
  for (const [path, content] of contents) { await mkdir(dirname(join(resourceRoot, path)), { recursive: true, mode: 0o700 }); await writeFile(join(resourceRoot, path), content, { mode: 0o600 }); }
  const manifest = { schemaVersion: 1, ...pins, roles, entries: contents.map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex') })), dependencyClosure: contents.map(([path]) => path) };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return { privateRoot, resourceRoot, dataRoot, controlRoot, canaryPath, manifestPath };
}
async function prepare(config) { assert.equal(typeof module.prepareQQInvocation, 'function'); return module.prepareQQInvocation(config); }

test('private diagnostics persist only the latest 64 sanitized phases across attempts', async t => {
  assert.equal(typeof module.createQQDiagnosticRecorder, 'function');
  const config = await fixture(t), record = module.createQQDiagnosticRecorder(config);
  const first = randomUUID(), second = randomUUID();
  const writes = [];
  for (let index = 0; index < 100; index++) writes.push(record({ attemptId: index < 50 ? first : second, phase: 'msf_status', elapsedMs: index, code: 0 }));
  assert.ok((await Promise.all(writes)).every(Boolean));
  const path = join(config.controlRoot, 'diagnostics.json');
  const entries = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(entries.length, 64);
  assert.deepEqual(entries[0], { attemptId: first, phase: 'msf_status', elapsedMs: 36, code: 0 });
  assert.deepEqual(entries.at(-1), { attemptId: second, phase: 'msf_status', elapsedMs: 99, code: 0 });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const before = await readFile(path, 'utf8');
  for (const data of [
    { attemptId: first, phase: 'qr_received', elapsedMs: 1, dataUrl: 'private-qr' },
    { attemptId: first, phase: 'arbitrary-secret', elapsedMs: 1 },
    { attemptId: first, phase: 'qr_received', elapsedMs: 1, code: 'secret-account' },
    { attemptId: '123456', phase: 'qr_received', elapsedMs: 1 },
    { attemptId: first, phase: 'qr_received', elapsedMs: Infinity },
  ]) assert.equal(await record(data), false);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('private diagnostics refuse aliased or insecure files without following the target', async t => {
  assert.equal(typeof module.createQQDiagnosticRecorder, 'function');
  const config = await fixture(t), path = join(config.controlRoot, 'diagnostics.json');
  const original = await readFile(config.canaryPath, 'utf8');
  await symlink(config.canaryPath, path);
  const record = module.createQQDiagnosticRecorder(config);
  const entry = { attemptId: randomUUID(), phase: 'transport_connect', elapsedMs: 0 };
  assert.equal(await record(entry), false);
  assert.equal(await readFile(config.canaryPath, 'utf8'), original);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  await rm(path);
  await writeFile(path, 'untrusted diagnostics', { mode: 0o666 });
  await chmod(path, 0o666);
  assert.equal(await record(entry), false);
  assert.equal(await readFile(path, 'utf8'), 'untrusted diagnostics');
});

test('trusted installed assets produce only the fixed isolated native invocation', async t => {
  const config = await fixture(t), invocation = await prepare(config);
  assert.equal(invocation.command, '/usr/bin/sandbox-exec');
  assert.equal(invocation.cwd, config.dataRoot);
  assert.deepEqual(invocation.args.slice(-4), [join(config.resourceRoot, roles.bootstrap), config.canaryPath, join(config.resourceRoot, roles.worker), join(config.controlRoot, 'run.json')]);
  assert.ok(invocation.args.includes(`PRIVATE_ROOT=${config.privateRoot}`));
  assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(Object.hasOwn(invocation.env, 'HOME'), false);
  assert.equal(Object.hasOwn(invocation.env, 'CODEX_HOME'), false);
  const worker = JSON.parse(await readFile(join(config.controlRoot, 'run.json'), 'utf8'));
  assert.equal(worker.wrapperPath, join(config.resourceRoot, roles.wrapper));
  assert.equal(worker.schemaVersion, 1);
  assert.deepEqual(worker.expectedNativeABI, pins.nativeABI);
  assert.equal(Object.hasOwn(worker, 'endpoint'), false);
  assert.deepEqual(await prepare(config), invocation, 'an explicit refresh can reuse private paths after the previous tree stopped');
});

test('an altered native dependency is rejected at use and cannot produce a worker config', async t => {
  const config = await fixture(t);
  await writeFile(join(config.resourceRoot, roles.wrapper), 'tampered dependency');
  await assert.rejects(prepare(config), { code: 'RESOURCE_INVALID' });
  await assert.rejects(readFile(join(config.controlRoot, 'run.json')), { code: 'ENOENT' });
});

test('session, control and canary paths cannot leave the dedicated QQ root or overlap resources', async t => {
  const config = await fixture(t);
  await assert.rejects(prepare({ ...config, dataRoot: dirname(config.privateRoot) }), { code: 'RESOURCE_INVALID' });
  await assert.rejects(prepare({ ...config, dataRoot: config.resourceRoot }), { code: 'RESOURCE_INVALID' });
  await assert.rejects(prepare({ ...config, controlRoot: config.dataRoot }), { code: 'RESOURCE_INVALID' });
  await assert.rejects(prepare({ ...config, canaryPath: join(config.dataRoot, 'canary') }), { code: 'RESOURCE_INVALID' });
});

test('manifest and private session aliases are rejected without following them', async t => {
  const config = await fixture(t), link = join(config.privateRoot, 'linked-session');
  await symlink(config.dataRoot, link);
  await assert.rejects(prepare({ ...config, dataRoot: link }), { code: 'RESOURCE_INVALID' });
  await chmod(config.manifestPath, 0o666);
  await assert.rejects(prepare(config), { code: 'RESOURCE_INVALID' });
});

test('factory construction is lazy and forgetting removes only the confirmed private session', async t => {
  assert.equal(typeof module.createManagedQQRuntime, 'function');
  const config = await fixture(t), runtime = module.createManagedQQRuntime(config);
  t.after(() => runtime.stop());
  await writeFile(join(config.dataRoot, 'session-secret'), 'private', { mode: 0o600 });
  assert.equal(runtime.status().running, false);
  await runtime.forget({ ownerAction: true });
  await assert.rejects(readFile(join(config.dataRoot, 'session-secret')), { code: 'ENOENT' });
  assert.ok(await readFile(config.manifestPath));
  assert.ok(await readFile(config.canaryPath));
  assert.ok(await readFile(join(config.resourceRoot, roles.wrapper)));
});

test('forget can remove owned session data even when installed native resources are unavailable', async t => {
  const config = await fixture(t), runtime = module.createManagedQQRuntime(config);
  t.after(() => runtime.stop());
  await writeFile(join(config.dataRoot, 'session-secret'), 'private', { mode: 0o600 });
  await rm(config.resourceRoot, { recursive: true });
  await rm(config.canaryPath);
  await runtime.forget({ ownerAction: true });
  await assert.rejects(readFile(join(config.dataRoot, 'session-secret')), { code: 'ENOENT' });
});
