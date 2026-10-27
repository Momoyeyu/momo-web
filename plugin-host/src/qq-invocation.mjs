import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { qualifyQQResources } from './qq-resources.mjs';
import { QQRuntimeManager, QQRuntimeError, sanitizeQQDiagnostic } from './qq-runtime.mjs';

const fields = ['privateRoot', 'resourceRoot', 'manifestPath', 'dataRoot', 'controlRoot', 'canaryPath'];
const valid = condition => { if (!condition) throw new QQRuntimeError('RESOURCE_INVALID'); };
const contained = (parent, child) => { const suffix = relative(parent, child); return suffix && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const overlaps = (left, right) => left === right || contained(left, right) || contained(right, left);
function trustedConfig(input) {
  valid(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === fields.length && fields.every(field => Object.hasOwn(input, field)));
  const config = Object.fromEntries(fields.map(field => [field, input[field]]));
  for (const path of Object.values(config)) valid(typeof path === 'string' && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path) && isAbsolute(path) && normalize(path) === path && dirname(path) !== path);
  for (const field of fields.filter(field => field !== 'privateRoot')) valid(contained(config.privateRoot, config[field]));
  for (const left of ['resourceRoot', 'dataRoot', 'controlRoot']) for (const right of fields.filter(field => field !== 'privateRoot' && field !== left)) valid(!overlaps(config[left], config[right]));
  valid(config.manifestPath !== config.canaryPath);
  return Object.freeze(config);
}
async function privateDirectory(path) {
  const stat = await lstat(path);
  valid(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && await realpath(path) === path);
}
async function privateFile(path, limit = 4 * 1024 * 1024) {
  valid(await realpath(path) === path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    valid(before.isFile() && before.uid === process.getuid() && before.nlink === 1 && (before.mode & 0o077) === 0 && before.size <= limit);
    const content = await handle.readFile(), after = await handle.stat(), current = await lstat(path);
    valid(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && current.ino === after.ino && current.dev === after.dev && await realpath(path) === path);
    return content;
  } finally { await handle.close(); }
}
async function validatedPaths(config) {
  valid(typeof process.getuid === 'function');
  for (const path of [config.privateRoot, config.resourceRoot, config.dataRoot, config.controlRoot]) await privateDirectory(path);
  // These are installed, readable synthetic bytes. The OS profile must deny
  // the launcher's read of them before the native framework can be loaded.
  await privateFile(config.canaryPath, 1024);
}
async function writeRunConfig(path, value) {
  try { await lstat(path); await privateFile(path, 64 * 1024); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  const temporary = join(dirname(path), `.run-${randomUUID()}.json`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Prepare only preinstalled, fully qualified resources; never download or scan QQ. */
export async function prepareQQInvocation(input) {
  try {
    const config = trustedConfig(input);
    await validatedPaths(config);
    const manifest = JSON.parse((await privateFile(config.manifestPath)).toString('utf8'));
    const qualified = await qualifyQQResources({ root: config.resourceRoot, manifest });
    valid(qualified.qq.version === '6.9.95' && qualified.qq.buildVersion === '48517');
    const temporaryRoot = join(config.dataRoot, 'tmp');
    try { await mkdir(temporaryRoot, { mode: 0o700 }); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    await privateDirectory(temporaryRoot);
    const configPath = join(config.controlRoot, 'run.json');
    await writeRunConfig(configPath, { schemaVersion: 1, privateRoot: config.privateRoot, resourceRoot: config.resourceRoot, dataRoot: config.dataRoot, wrapperPath: qualified.paths.wrapper, canaryPath: config.canaryPath, expectedNativeABI: qualified.nativeABI });
    const userHome = await realpath(homedir());
    const ancestors = [];
    for (let path = dirname(config.privateRoot); path !== dirname(path); path = dirname(path)) ancestors.push(path);
    valid(ancestors.length <= 16);
    const parameters = { USER_HOME: userHome, PRIVATE_ROOT: config.privateRoot, CANARY_PATH: config.canaryPath, ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`ANCESTOR_${index}`, ancestors[index] ?? '/dev/null'])) };
    return {
      command: '/usr/bin/sandbox-exec',
      args: [...Object.entries(parameters).flatMap(([key, value]) => ['-D', `${key}=${value}`]), '-f', qualified.paths.profile, qualified.paths.bootstrap, config.canaryPath, qualified.paths.worker, configPath],
      cwd: config.dataRoot,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', TMPDIR: temporaryRoot, ELECTRON_RUN_AS_NODE: '1' },
    };
  } catch (cause) { throw new QQRuntimeError(cause?.code === 'ENOENT' ? 'RESOURCE_UNAVAILABLE' : 'RESOURCE_INVALID'); }
}

/** Internal-only, bounded timing evidence; never an account or native log sink. */
export function createQQDiagnosticRecorder(input) {
  const config = trustedConfig(input), path = join(config.controlRoot, 'diagnostics.json');
  let records = [], dirty = false, writing = null;
  return value => {
    const record = sanitizeQQDiagnostic(value);
    if (!record) return Promise.resolve(false);
    records.push(record);
    if (records.length > 64) records = records.slice(-64);
    dirty = true;
    if (!writing) {
      // Coalesce callbacks while disk IO is pending instead of accumulating a
      // promise or file write for each native notification.
      writing = (async () => {
        try {
          while (dirty) {
            dirty = false;
            const snapshot = [...records];
            await privateDirectory(config.privateRoot);
            await privateDirectory(config.controlRoot);
            await writeRunConfig(path, snapshot);
          }
          return true;
        } catch { return false; }
        finally { writing = null; }
      })();
    }
    return writing;
  };
}

export function createManagedQQRuntime(input) {
  const config = trustedConfig(input);
  return new QQRuntimeManager({
    prepareInvocation: () => prepareQQInvocation(config),
    onDiagnostic: createQQDiagnosticRecorder(config),
    forgetSession: async () => {
      await privateDirectory(config.privateRoot);
      await privateDirectory(config.dataRoot);
      // Manager invokes this only after its entire owned process group stopped.
      // Recursive unlink never follows directory symlinks inside this session.
      await rm(config.dataRoot, { recursive: true });
      await mkdir(config.dataRoot, { mode: 0o700 });
      await privateDirectory(config.dataRoot);
    },
  });
}
