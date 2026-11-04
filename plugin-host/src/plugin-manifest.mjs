/** Data-only package contract. Validation MUST NOT import or execute package code. */
export const PLUGIN_API_VERSION = 1;
export const PLUGIN_CAPABILITIES = Object.freeze([
  'screen.observe', 'speech.proactive', 'computer.pointer', 'computer.keyboard',
  'browser.navigate', 'network.access', 'files.read', 'files.write',
  'game.observe', 'game.move', 'game.chat', 'game.modify',
]);
const keys = new Set(['schemaVersion', 'id', 'version', 'name', 'description', 'entry', 'capabilities']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = message => { throw new Error(`Invalid plugin manifest: ${message}`); };
export function validatePluginManifest(input) {
  if (!plain(input)) invalid('expected object');
  if (Object.keys(input).some(key => !keys.has(key))) invalid('unknown field');
  if (input.schemaVersion !== PLUGIN_API_VERSION) invalid('unsupported schema version');
  if (typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(input.id)
      || input.id.startsWith('momo-')) invalid('invalid or reserved id');
  if (typeof input.version !== 'string' || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(input.version)) invalid('expected release version');
  for (const [key, limit] of [['name', 80], ['description', 1000]]) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > limit
        || /[\u0000-\u001f\u007f]/.test(input[key])) invalid(`invalid ${key}`);
  }
  // Portable POSIX path within the extracted package; resolve and symlink checks
  // still belong to the installer. No URLs, absolute paths or parent traversal.
  if (typeof input.entry !== 'string' || input.entry.length > 200
      || !/^[a-zA-Z0-9_/-]+\.mjs$/.test(input.entry)
      || input.entry.startsWith('/') || input.entry.split('/').some(part => !part || part === '..')) invalid('invalid entry');
  if (!Array.isArray(input.capabilities) || input.capabilities.length > PLUGIN_CAPABILITIES.length
      || input.capabilities.some(value => !PLUGIN_CAPABILITIES.includes(value))
      || new Set(input.capabilities).size !== input.capabilities.length) invalid('invalid capabilities');
  return Object.freeze({ ...input, capabilities: Object.freeze([...input.capabilities]) });
}
