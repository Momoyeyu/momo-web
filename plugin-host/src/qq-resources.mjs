import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, posix, relative, sep } from 'node:path';

const NATIVE_ROLES = Object.freeze({
  runtime: 'QQRuntime.app/Contents/Frameworks/QQNT.framework/Versions/A/QQNT',
  major: 'QQRuntime.app/Contents/Resources/app/major.node',
  wrapper: 'QQRuntime.app/Contents/Resources/app/wrapper.node',
});
const BOOTSTRAP = 'QQRuntime.app/Contents/MacOS/MomoQQRuntime';
const ROLE_NAMES = [...Object.keys(NATIVE_ROLES), 'worker', 'bootstrap', 'profile', 'metadata'];
const PIN_NAMES = ['resourceId', 'version', 'platform', 'architecture', 'nativeABI', 'qq'];
const ABI_NAMES = ['electron', 'node', 'modules', 'napi'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keysAre = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !['latest', 'stable', 'current'].includes(value.toLowerCase());
const version = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})\.(?:0|[1-9]\d{0,7})$/.test(value);
const integerPin = value => typeof value === 'string' && /^[1-9]\d{0,7}$/.test(value);
const invalid = () => Object.assign(new Error('Managed QQ resources are not qualified'), { name: 'QQResourceError', code: 'RESOURCE_INVALID' });
function requireValid(condition) { if (!condition) throw invalid(); }

function relativePath(value) {
  requireValid(typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\\') && !/[\x00-\x1f\x7f:]/.test(value));
  requireValid(!posix.isAbsolute(value) && posix.normalize(value) === value && value.split('/').every(part => part && part !== '.' && part !== '..' && part === part.trim() && part.normalize('NFC') === part));
  return value;
}
const pathAlias = value => value.normalize('NFC').toLowerCase();
function validatePins(pins) {
  requireValid(identifier(pins.resourceId) && identifier(pins.version));
  // This resource layout currently describes only the tested macOS arm64 target.
  // Qualification can inspect a target package on another host; it never executes it.
  requireValid(pins.platform === 'darwin' && pins.architecture === 'arm64');
  requireValid(keysAre(pins.nativeABI, ABI_NAMES) && version(pins.nativeABI.electron) && version(pins.nativeABI.node) && integerPin(pins.nativeABI.modules) && integerPin(pins.nativeABI.napi));
  requireValid(keysAre(pins.qq, ['version', 'buildVersion']) && version(pins.qq.version) && integerPin(pins.qq.buildVersion));
}
function validateManifest(manifest) {
  requireValid(keysAre(manifest, ['schemaVersion', ...PIN_NAMES, 'roles', 'entries', 'dependencyClosure']) && manifest.schemaVersion === 1);
  validatePins(manifest);
  requireValid(keysAre(manifest.roles, ROLE_NAMES));
  for (const [role, path] of Object.entries(NATIVE_ROLES)) requireValid(manifest.roles[role] === path);
  for (const role of ROLE_NAMES) relativePath(manifest.roles[role]);
  requireValid(new Set(Object.values(manifest.roles).map(pathAlias)).size === ROLE_NAMES.length);
  requireValid(manifest.roles.bootstrap === BOOTSTRAP);
  for (const role of ['worker', 'profile', 'metadata']) {
    // Original control code/profile and its metadata are separate from vendor code.
    requireValid(!pathAlias(manifest.roles[role]).startsWith('qqruntime.app/'));
    requireValid(role === 'worker' ? /\.(?:cjs|mjs)$/.test(manifest.roles.worker) : manifest.roles[role].endsWith({ profile: '.sb', metadata: '.json' }[role]));
  }
  requireValid(Array.isArray(manifest.entries) && manifest.entries.length >= ROLE_NAMES.length && manifest.entries.length <= 8192);
  const entries = new Map(), aliases = new Set(), prefixes = new Map();
  for (const entry of manifest.entries) {
    const symbolic = keysAre(entry, ['path', 'symlink']);
    requireValid(symbolic || (keysAre(entry, ['path', 'sha256']) && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)));
    if (symbolic) {
      requireValid(typeof entry.symlink === 'string' && entry.symlink.length > 0 && entry.symlink.length <= 1024 && !/[\\\x00-\x1f\x7f:]/.test(entry.symlink) && !posix.isAbsolute(entry.symlink) && posix.normalize(entry.symlink) === entry.symlink);
      relativePath(posix.normalize(posix.join(posix.dirname(entry.path), entry.symlink)));
    }
    relativePath(entry.path);
    const alias = pathAlias(entry.path), name = basename(alias);
    // Do not qualify the vendor application's general entrypoint, archive loader,
    // or package main. The original worker consumes only the pinned native parts.
    requireValid(!aliases.has(alias) && !['package.json', 'app_launcher', 'application.asar', 'app.asar'].includes(name) && !name.endsWith('.asar'));
    let prefix = '';
    for (const part of entry.path.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = pathAlias(prefix);
      requireValid(!prefixes.has(key) || prefixes.get(key) === prefix); prefixes.set(key, prefix);
    }
    aliases.add(alias); entries.set(entry.path, entry);
  }
  requireValid(ROLE_NAMES.every(role => entries.has(manifest.roles[role]) && Object.hasOwn(entries.get(manifest.roles[role]), 'sha256')));
  requireValid(Array.isArray(manifest.dependencyClosure) && manifest.dependencyClosure.length === entries.size);
  const closure = new Set();
  for (const path of manifest.dependencyClosure) {
    relativePath(path); requireValid(entries.has(path) && !closure.has(path)); closure.add(path);
  }
  return entries;
}
const unchanged = (before, after) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].every(key => before[key] === after[key]);
function owned(stat, uid) { return stat.uid === uid && (stat.mode & 0o022) === 0; }
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function parentDirectories(entries) {
  const parents = new Set(['.']);
  for (const path of entries.keys()) for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent)) parents.add(parent);
  return parents;
}
async function inventory(root, entries, uid) {
  const parents = parentDirectories(entries), files = new Map();
  async function walk(directory, prefix = '') {
    for (const name of await readdir(directory)) {
      const path = prefix ? `${prefix}/${name}` : name;
      relativePath(path);
      const absolute = join(root, path), stat = await lstat(absolute), entry = entries.get(path);
      requireValid(stat.uid === uid);
      if (stat.isSymbolicLink()) {
        requireValid(entry && Object.hasOwn(entry, 'symlink') && await readlink(absolute) === entry.symlink);
        files.set(path, stat); // Never follow directory links while enumerating.
      } else {
        requireValid(owned(stat, uid));
        if (stat.isDirectory()) { requireValid(parents.has(path) && !entry); await walk(absolute, path); }
        else { requireValid(stat.isFile() && stat.nlink === 1 && entry && Object.hasOwn(entry, 'sha256')); files.set(path, stat); }
      }
    }
  }
  await walk(root);
  requireValid(files.size === entries.size);
  return files;
}
async function verifyLinks(root, entries, snapshots) {
  const parents = parentDirectories(entries), links = new Map();
  const edges = new Map([...parents].map(path => [path, new Set()]));
  for (const path of parents) if (path !== '.') edges.get(posix.dirname(path)).add(path);
  for (const entry of entries.values()) {
    if (!Object.hasOwn(entry, 'symlink')) continue;
    const absolutePath = join(root, entry.path), canonicalPath = await realpath(absolutePath);
    const canonical = relative(root, canonicalPath).split(sep).join('/');
    requireValid(canonical && !canonical.startsWith('../') && !isAbsolute(canonical) && (parents.has(canonical) || Object.hasOwn(entries.get(canonical) ?? {}, 'sha256')));
    requireValid(await readlink(absolutePath) === entry.symlink && unchanged(snapshots.get(entry.path), await lstat(absolutePath)));
    if (parents.has(canonical)) edges.get(posix.dirname(entry.path)).add(canonical);
    links.set(entry.path, { path: entry.path, absolutePath, symlink: entry.symlink, canonicalPath });
  }
  // realpath catches link-resolution loops; this graph additionally catches
  // directory traversal loops such as child/up -> .. and cross-directory cycles.
  const visiting = new Set(), visited = new Set();
  function visit(path) {
    requireValid(!visiting.has(path));
    if (visited.has(path)) return;
    visiting.add(path); for (const child of edges.get(path)) visit(child);
    visiting.delete(path); visited.add(path);
  }
  visit('.');
  return links;
}
async function verifyFile(root, entry, expectedStat, uid, metadata) {
  const absolutePath = join(root, entry.path);
  requireValid(await realpath(absolutePath) === absolutePath);
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content;
  try {
    const before = await handle.stat();
    requireValid(before.isFile() && before.nlink === 1 && owned(before, uid) && unchanged(expectedStat, before));
    const hash = createHash('sha256');
    if (metadata) { requireValid(before.size <= 16 * 1024); content = await handle.readFile(); hash.update(content); }
    else for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    requireValid(hash.digest('hex') === entry.sha256 && unchanged(before, await handle.stat()));
    requireValid(unchanged(before, await lstat(absolutePath)) && await realpath(absolutePath) === absolutePath);
  } finally { await handle.close(); }
  return { verified: { path: entry.path, absolutePath, sha256: entry.sha256 }, content };
}

/**
 * Offline qualification only. The manifest is a trusted, reviewed server input;
 * never load it from an account request or treat a package's own metadata as pins.
 * Every canonical file in the closure is owned and hashed; internal symlinks
 * have exact relative target pins, contained canonical targets, and no cycles.
 * ABI fields describe expected pins, not observed native execution/compatibility.
 * The result is a point-in-time snapshot: callers must requalify before use and
 * keep the owned tree protected from modification throughout an invocation.
 * This function does not install, download, scan system QQ, or execute anything.
 */
export async function qualifyQQResources({ root, manifest } = {}) {
  try {
    // Snapshot trusted inputs before asynchronous IO so later caller mutation
    // cannot replace paths or hashes while qualification is in progress.
    manifest = structuredClone(manifest);
    const entries = validateManifest(manifest);
    requireValid(typeof root === 'string' && root.length <= 4096 && isAbsolute(root) && normalize(root) === root && dirname(root) !== root && await realpath(root) === root);
    requireValid(typeof process.getuid === 'function');
    const uid = process.getuid(), initialRoot = await lstat(root);
    requireValid(initialRoot.isDirectory() && !initialRoot.isSymbolicLink() && initialRoot.uid === uid && (initialRoot.mode & 0o077) === 0);
    const files = await inventory(root, entries, uid), links = await verifyLinks(root, entries, files), verified = [];
    let metadata;
    for (const entry of entries.values()) {
      if (Object.hasOwn(entry, 'symlink')) { verified.push(links.get(entry.path)); continue; }
      const result = await verifyFile(root, entry, files.get(entry.path), uid, entry.path === manifest.roles.metadata);
      verified.push(result.verified);
      if (result.content) metadata = JSON.parse(result.content.toString('utf8'));
    }
    requireValid(keysAre(metadata, PIN_NAMES)); validatePins(metadata);
    for (const key of ['resourceId', 'version', 'platform', 'architecture']) requireValid(metadata[key] === manifest[key]);
    for (const key of ABI_NAMES) requireValid(metadata.nativeABI[key] === manifest.nativeABI[key]);
    for (const key of ['version', 'buildVersion']) requireValid(metadata.qq[key] === manifest.qq[key]);
    const finalRoot = await lstat(root);
    requireValid(finalRoot.isDirectory() && finalRoot.uid === uid && (finalRoot.mode & 0o077) === 0 && initialRoot.ino === finalRoot.ino && initialRoot.dev === finalRoot.dev && await realpath(root) === root);
    const finalFiles = await inventory(root, entries, uid);
    for (const [path, initial] of files) requireValid(unchanged(initial, finalFiles.get(path)));
    const finalLinks = await verifyLinks(root, entries, finalFiles);
    for (const [path, initial] of links) requireValid(initial.canonicalPath === finalLinks.get(path).canonicalPath);
    const pins = Object.fromEntries(PIN_NAMES.map(key => [key, manifest[key]]));
    return freeze({ kind: 'qq-resource-qualification', schemaVersion: 1, ...pins, root, paths: Object.fromEntries(ROLE_NAMES.map(role => [role, join(root, manifest.roles[role])])), entries: verified });
  } catch { throw invalid(); }
}
