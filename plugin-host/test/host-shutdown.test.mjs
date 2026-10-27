import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginHost } from '../src/host.mjs';

function blockedPlugin() {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  return {
    release,
    plugin: { id: 'inert-mcp', config: { type: 'mcp', transport: 'stdio' }, enabled: true,
      connected: true, controllers: new Set(), client: { close: () => blocked },
      transport: null, fiber: null },
  };
}

test('shutdown begins native process reclamation before an unrelated MCP close can stall it', async () => {
  let nativeRunning = true;
  const host = new PluginHost({ qqRuntime: { stop: async () => {
    nativeRunning = false; return { executorQuiescent: true };
  } } });
  const { plugin, release } = blockedPlugin();
  host.plugins.set(plugin.id, plugin);
  const closing = host.close();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nativeRunning, false, 'detached QQ cleanup must not wait behind another plugin');
  } finally { release(); await closing; }
});

test('shutdown has one overall deadline and never claims a stuck plugin was stopped', async () => {
  const host = new PluginHost({ stopTimeoutMs: 20, qqRuntime: {
    stop: async () => ({ executorQuiescent: true }),
  } });
  const { plugin, release } = blockedPlugin();
  host.plugins.set(plugin.id, plugin);
  const closing = host.close();
  try {
    const result = await Promise.race([
      closing,
      new Promise(resolve => setTimeout(() => resolve(null), 150)),
    ]);
    assert.deepEqual(result, { stopped: false });
    assert.deepEqual(await host.close(), { stopped: false });
  } finally { release(); await closing; }
});
