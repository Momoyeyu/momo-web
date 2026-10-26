import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fstatSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath, symlink, link, open, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const loaded = await import('../src/qq-resources.mjs').catch(() => ({}));
const roles = {
  runtime: 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A/QQNT',
  major: 'QQRuntime.app/Contents/Resources/app/major.node',
  wrapper: 'QQRuntime.app/Contents/Resources/app/wrapper.node',
  worker: 'momo/worker.mjs', bootstrap: 'QQRuntime.app/Contents/MacOS/MomoQQRuntime', profile: 'momo/private.sb', metadata: 'momo/resource.json',
};
const pins = {
  resourceId: 'momo-qq-fixture', version: 'fixture-1', platform: 'darwin', architecture: 'arm64',
  nativeABI: { electron: '37.1.0', node: '22.16.0', modules: '136', napi: '10' },
  qq: { version: '6.9.95', buildVersion: '48517' },
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'momo-qq-resources-')));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  // No native code is loaded: every resource is synthetic, inert text.
  const contents = new Map(Object.entries(roles).map(([role, path]) => [path, `${role} pinned fixture\n`]));
  contents.set(roles.metadata, JSON.stringify(pins));
  contents.set('QQRuntime.app/Contents/Frameworks/QtCore.framework/Versions/A/QtCore', 'pinned native dependency\n');
  for (const [path, content] of contents) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), content, { mode: 0o600 });
  }
  return {
    root, contents,
    manifest: { schemaVersion: 1, ...structuredClone(pins), roles: { ...roles }, entries: [...contents].map(([path, content]) => ({ path, sha256: digest(content) })), dependencyClosure: [...contents.keys()] },
  };
}
async function qualify(args) {
  assert.equal(typeof loaded.qualifyQQResources, 'function', 'offline QQ resource qualification is implemented');
  return loaded.qualifyQQResources(args);
}
const rejects = args => assert.rejects(qualify(args), { code: 'RESOURCE_INVALID' });

// Removing hashing, path containment, private ownership, or pin comparison breaks
// the corresponding behavioral tests below, independently of qualifier helpers.
test('qualification returns immutable verified paths and expected pins without an executable invocation', async t => {
  const { root, manifest } = await fixture(t);
  const result = await qualify({ root, manifest });
  assert.equal(result.kind, 'qq-resource-qualification');
  assert.equal(result.resourceId, 'momo-qq-fixture');
  assert.deepEqual(result.qq, { version: '6.9.95', buildVersion: '48517' });
  assert.equal(result.nativeABI.modules, '136');
  assert.equal(result.root, root);
  assert.equal(result.paths.runtime, join(root, roles.runtime));
  assert.equal(result.paths.worker, join(root, 'momo/worker.mjs'));
  assert.equal(result.entries.length, 8);
  assert.equal(result.entries.find(entry => entry.path === roles.wrapper).sha256, digest('wrapper pinned fixture\n'));
  assert.equal(Object.hasOwn(result, 'command'), false);
  assert.equal(Object.hasOwn(result, 'runtimeObserved'), false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.paths) && Object.isFrozen(result.entries) && Object.isFrozen(result.entries[0]) && Object.isFrozen(result.nativeABI));
  manifest.nativeABI.modules = '0'; manifest.roles.worker = 'elsewhere.mjs';
  assert.equal(result.nativeABI.modules, '136');
  assert.equal(result.paths.worker, join(root, 'momo/worker.mjs'));
});

for (const role of ['runtime', 'major', 'wrapper', 'worker', 'bootstrap', 'profile', 'metadata']) {
  test(`tampering with pinned ${role} bytes prevents qualification`, async t => {
    const args = await fixture(t);
    await writeFile(join(args.root, roles[role]), 'changed after installation');
    await rejects(args);
  });
}

test('every declared dependency is hashed rather than only the primary native modules', async t => {
  const args = await fixture(t);
  await writeFile(join(args.root, 'QQRuntime.app/Contents/Frameworks/QtCore.framework/Versions/A/QtCore'), 'dependency replacement');
  await rejects(args);
});

test('missing required resources do not become an available runtime', async t => {
  const args = await fixture(t);
  await rm(join(args.root, roles.wrapper));
  await rejects(args);
});

test('the exact file inventory rejects unpinned native or script additions', async t => {
  const args = await fixture(t);
  await writeFile(join(args.root, 'QQRuntime.app/Contents/Resources/app/preload.node'), 'unreviewed preload');
  await rejects(args);
});

for (const path of ['/tmp/worker.mjs', '../worker.mjs', 'momo/../worker.mjs', 'momo//worker.mjs', './momo/worker.mjs', 'C:\\worker.mjs', 'momo\\worker.mjs']) {
  test(`a manifest path cannot escape or alias the resource root: ${path}`, async t => {
    const args = await fixture(t);
    args.manifest.entries[0].path = path;
    args.manifest.dependencyClosure[0] = path;
    await rejects(args);
  });
}

test('duplicate entries and case insensitive aliases are rejected before qualification', async t => {
  const args = await fixture(t);
  args.manifest.entries.push({ ...args.manifest.entries[0] });
  args.manifest.dependencyClosure.push(args.manifest.entries[0].path);
  await rejects(args);
  args.manifest.entries.at(-1).path = 'QQRuntime.app/Contents/Resources/app/MAJOR.node';
  args.manifest.dependencyClosure[args.manifest.dependencyClosure.length - 1] = args.manifest.entries.at(-1).path;
  await rejects(args);
});

test('symlinked resource files cannot redirect pinned paths outside the private tree', async t => {
  const args = await fixture(t);
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'momo-qq-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'worker.mjs'), args.contents.get(roles.worker));
  await rm(join(args.root, roles.worker));
  await symlink(join(outside, 'worker.mjs'), join(args.root, roles.worker));
  await rejects(args);
});

test('symlinked parent directories cannot redirect a valid looking native path', async t => {
  const args = await fixture(t);
  const nativeDirectory = join(args.root, 'QQRuntime.app/Contents/Resources/app');
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'momo-qq-native-outside-')));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'major.node'), args.contents.get(roles.major));
  await writeFile(join(outside, 'wrapper.node'), args.contents.get(roles.wrapper));
  await rm(nativeDirectory, { recursive: true });
  await symlink(outside, nativeDirectory);
  await rejects(args);
});

test('a root must already be canonical, owned, and private', async t => {
  const args = await fixture(t);
  await rejects({ ...args, root: `${args.root}/.` });
  const alias = `${args.root}-alias`;
  await symlink(args.root, alias); t.after(() => rm(alias, { force: true }));
  await rejects({ ...args, root: alias });
  await chmod(args.root, 0o755);
  await rejects(args);
});

test('hard links cannot leave mutable aliases of pinned resources', async t => {
  const args = await fixture(t);
  const alias = `${args.root}-hardlink`;
  await link(join(args.root, roles.worker), alias); t.after(() => rm(alias, { force: true }));
  await rejects(args);
});

for (const mutate of [
  manifest => { delete manifest.roles.wrapper; },
  manifest => { manifest.roles.runtime = 'QQ.app/Contents/MacOS/QQ'; },
  manifest => { manifest.roles.worker = manifest.roles.major; },
  manifest => { manifest.roles.extra = 'momo/extra.mjs'; },
  manifest => { manifest.entries[0].sha256 = 'not-a-sha256'; },
  manifest => { manifest.dependencyClosure.pop(); },
  manifest => { manifest.dependencyClosure.push('missing.node'); },
  manifest => { manifest.nativeABI.modules = 'latest'; },
  manifest => { manifest.nativeABI.electron = '*'; },
  manifest => { manifest.architecture = 'any'; },
  manifest => { manifest.version = 'latest'; },
  manifest => { manifest.schemaVersion = 2; },
  manifest => { manifest.command = '/usr/bin/open'; },
]) {
  test(`an incomplete or unpinned manifest fails closed (${mutate.toString()})`, async t => {
    const args = await fixture(t); mutate(args.manifest); await rejects(args);
  });
}

for (const field of ['version', 'platform', 'architecture', 'qq', 'nativeABI']) {
  test(`hashed resource metadata must agree with the trusted ${field} pin`, async t => {
    const args = await fixture(t);
    const metadata = JSON.parse(await readFile(join(args.root, roles.metadata), 'utf8'));
    if (field === 'nativeABI') metadata.nativeABI.modules = '135';
    else if (field === 'qq') metadata.qq.buildVersion = 'different-build';
    else metadata[field] = field === 'architecture' ? 'x64' : 'different';
    const text = JSON.stringify(metadata);
    await writeFile(join(args.root, roles.metadata), text);
    // Independently pin these bytes: a hash match alone cannot establish that the
    // installed metadata agrees with the reviewed resource contract.
    args.manifest.entries.find(entry => entry.path === roles.metadata).sha256 = digest(text);
    await rejects(args);
  });
}

for (const path of ['QQRuntime.app/Contents/Resources/app/package.json', 'QQRuntime.app/Contents/Resources/app/application.asar', 'QQRuntime.app/Contents/MacOS/app_launcher']) {
  test(`vendor application entrypoints are excluded even if added to all hash pins: ${path}`, async t => {
    const args = await fixture(t);
    await mkdir(dirname(join(args.root, path)), { recursive: true }); await writeFile(join(args.root, path), 'vendor application entry');
    args.manifest.entries.push({ path, sha256: digest('vendor application entry') }); args.manifest.dependencyClosure.push(path);
    await rejects(args);
  });
}

test('filesystem errors are sanitized and do not reveal private paths', async t => {
  const args = await fixture(t);
  await rm(join(args.root, roles.major));
  await assert.rejects(qualify(args), error => error.code === 'RESOURCE_INVALID' && !error.message.includes(args.root) && !error.message.includes('major.node') && error.cause === undefined);
});

test('different file names cannot conceal case insensitive aliases of parent directories', async t => {
  const args = await fixture(t);
  for (const [path, content] of [['deps/a.node', 'dependency a'], ['DEPS/b.node', 'dependency b']]) {
    await mkdir(dirname(join(args.root, path)), { recursive: true }); await writeFile(join(args.root, path), content);
    args.manifest.entries.push({ path, sha256: digest(content) }); args.manifest.dependencyClosure.push(path);
  }
  await rejects(args);
});


test('qualification rejects an early file replacement while a later dependency is hashing', async t => {
  const args = await fixture(t);
  const path = 'tail-pinned-dependency.dat', absolute = join(args.root, path), content = 'later pinned dependency';
  await writeFile(absolute, content);
  args.manifest.entries.push({ path, sha256: digest(content) }); args.manifest.dependencyClosure.push(path);
  const tail = await stat(absolute), probe = await open(absolute);
  const prototype = Object.getPrototypeOf(probe), original = prototype.createReadStream;
  await probe.close();
  // Instrument the actual final file read to place a real filesystem replacement
  // exactly after the earlier runtime hash. The real stream and hash still run.
  t.mock.method(prototype, 'createReadStream', function (...options) {
    const current = fstatSync(this.fd);
    if (current.ino === tail.ino && current.dev === tail.dev) writeFileSync(join(args.root, roles.runtime), 'replaced after its own hash was checked');
    return original.apply(this, options);
  });
  await rejects(args);
});


async function addPinnedLink(args, path, target) {
  await mkdir(dirname(join(args.root, path)), { recursive: true });
  await symlink(target, join(args.root, path));
  args.manifest.entries.push({ path, symlink: target }); args.manifest.dependencyClosure.push(path);
}

test('pinned original native bootstrap and CJS worker are accepted as opaque resources', async t => {
  const args = await fixture(t);
  for (const [role, path] of [['worker', 'control/worker.cjs'], ['bootstrap', 'QQRuntime.app/Contents/MacOS/MomoQQRuntime']]) {
    const old = args.manifest.roles[role];
    if (old !== path) { await mkdir(dirname(join(args.root, path)), { recursive: true }); await rename(join(args.root, old), join(args.root, path)); }
    args.manifest.roles[role] = path;
    args.manifest.entries.find(entry => entry.path === old).path = path;
    args.manifest.dependencyClosure[args.manifest.dependencyClosure.indexOf(old)] = path;
  }
  const result = await qualify(args);
  assert.equal(result.paths.bootstrap, join(args.root, 'QQRuntime.app/Contents/MacOS/MomoQQRuntime'));
  assert.equal(result.paths.worker, join(args.root, 'control/worker.cjs'));
});

test('pinned internal framework links preserve the unchanged vendor layout and canonical hashes', async t => {
  const args = await fixture(t);
  await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current', 'A');
  await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/QQNT', 'Versions/Current/QQNT');
  const result = await qualify(args);
  assert.equal(result.entries.length, 10);
  assert.deepEqual(result.entries.find(entry => entry.path.endsWith('/Versions/Current')), {
    path: 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current',
    absolutePath: join(args.root, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current'),
    symlink: 'A', canonicalPath: join(args.root, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A'),
  });
  assert.equal(result.entries.find(entry => entry.path.endsWith('/QQNT.framework/QQNT')).canonicalPath, join(args.root, roles.runtime));
  assert.equal(result.entries.find(entry => entry.path === roles.runtime).sha256, digest('runtime pinned fixture\n'));
});

test('a pinned link does not excuse tampering with its canonical native target', async t => {
  const args = await fixture(t);
  await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/QQNT', 'Versions/A/QQNT');
  await writeFile(join(args.root, roles.runtime), 'tampered canonical native target');
  await rejects(args);
});

test('framework link destinations must match the reviewed link pin', async t => {
  const args = await fixture(t);
  await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current', 'A');
  const alternate = 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/B/QQNT', content = 'other pinned native target';
  await mkdir(dirname(join(args.root, alternate)), { recursive: true }); await writeFile(join(args.root, alternate), content);
  args.manifest.entries.push({ path: alternate, sha256: digest(content) }); args.manifest.dependencyClosure.push(alternate);
  await rm(join(args.root, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current'));
  await symlink('B', join(args.root, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current'));
  await rejects(args);
});

for (const target of ['/tmp', '../../../../../../../../tmp']) {
  test(`even a pinned framework link cannot escape its resource root: ${target}`, async t => {
    const args = await fixture(t);
    await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current', target);
    await rejects(args);
  });
}

test('pinned links cannot form a symbolic link resolution cycle', async t => {
  const args = await fixture(t);
  const prefix = 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions';
  await addPinnedLink(args, `${prefix}/Current`, 'Other'); await addPinnedLink(args, `${prefix}/Other`, 'Current');
  await rejects(args);
});

test('pinned directory links cannot create traversal cycles through real directories', async t => {
  const args = await fixture(t);
  await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A/loop', '../A');
  await rejects(args);
});

test('all files behind a permitted directory link remain in the exact hashed inventory', async t => {
  const args = await fixture(t);
  await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current', 'A');
  await writeFile(join(args.root, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A/unpinned.dylib'), 'unreviewed native dependency');
  await rejects(args);
});

test('links cannot replace canonical critical role files even when their destination is pinned', async t => {
  const args = await fixture(t);
  await rm(join(args.root, roles.worker)); await symlink(`../${roles.bootstrap}`, join(args.root, roles.worker));
  args.manifest.entries.find(entry => entry.path === roles.worker).symlink = `../${roles.bootstrap}`;
  delete args.manifest.entries.find(entry => entry.path === roles.worker).sha256;
  await rejects(args);
});


test('a pinned internal link cannot qualify a missing canonical target', async t => {
  const args = await fixture(t);
  await addPinnedLink(args, 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/Current', 'Missing');
  await rejects(args);
});
