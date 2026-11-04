import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePluginManifest } from '../src/plugin-manifest.mjs';
const base = () => ({ schemaVersion: 1, id: 'my-companion', version: '1.0.0', name: 'Companion', description: 'A companion extension', entry: 'dist/index.mjs', capabilities: ['screen.observe'] });
test('accepts a data-only manifest and copies capabilities', () => {
  const source = base(), result = validatePluginManifest(source);
  source.capabilities.push('files.write');
  assert.deepEqual(result.capabilities, ['screen.observe']);
  assert.ok(Object.isFrozen(result));
});
test('rejects incompatible versions, impersonation and undeclared contract fields', () => {
  for (const patch of [{ schemaVersion: 2 }, { id: 'momo-qq' }, { version: 'latest' }, { installScript: 'curl example' }, { capabilities: ['shell.execute'] }, { capabilities: ['screen.observe', 'screen.observe'] }]) {
    assert.throws(() => validatePluginManifest({ ...base(), ...patch }));
  }
});
test('rejects nonportable or escaping executable paths', () => {
  for (const entry of ['../index.mjs', '/tmp/index.mjs', 'dist/../index.mjs', 'https://host/index.mjs', 'dist\\index.mjs', 'dist//index.mjs']) {
    assert.throws(() => validatePluginManifest({ ...base(), entry }));
  }
});
