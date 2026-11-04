import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost } from '../src/host.mjs';

function fixture(transport, config = {}) {
  const host = new PluginHost({ stopTimeoutMs: 30 });
  const plugin = { id: 'external', config: { type: 'mcp', ...config }, enabled: true, connected: true, controllers: new Set(), tools: [], transport, client: null };
  host.plugins.set(plugin.id, plugin);
  return { host, plugin };
}

test('failed close retains disabled ownership and allows retry', async () => {
  let broken = true;
  const { host, plugin } = fixture({ async close() { if (broken) throw new Error('private'); } });
  await assert.rejects(host.configure({ plugins: [] }, host.configRevision), { code: 'PLUGIN_STOP' });
  assert.equal(host.plugins.get('external'), plugin);
  assert.equal(plugin.enabled, false);
  broken = false;
  await host.configure({ plugins: [] }, host.configRevision);
  assert.equal(host.plugins.size, 0);
  await host.close();
});

test('stdio close cannot claim success while captured process is alive', async () => {
  const { host, plugin } = fixture({ pid: process.pid, async close() {} }, { transport: 'stdio' });
  await assert.rejects(host.configure({ plugins: [] }, host.configRevision), { code: 'PLUGIN_STOP' });
  assert.equal(host.plugins.get('external'), plugin);
  assert.equal(plugin.closingPid, process.pid);
  // Test-only release: this fixture used our own pid, never a real child.
  plugin.closingPid = null;
  await host.configure({ plugins: [] }, host.configRevision);
  await host.close();
});
