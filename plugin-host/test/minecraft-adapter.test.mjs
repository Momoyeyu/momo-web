import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinecraftAdapter } from '../src/minecraft-adapter.mjs';
const permission = { world: 'private-test', account: 'test-account' };
function fixture() {
  const commands = [];
  const adapter = createMinecraftAdapter({ now: () => 1000, authorize: async () => true, transport: { request: async command => {
    commands.push(command);
    return { ...command, observedAt: 1000, stopped: true, heldControls: 0 };
  } } });
  return { adapter, commands };
}
test('missing managed runtime remains unavailable', async () => {
  const adapter = createMinecraftAdapter();
  assert.equal(adapter.status().available, false);
  await assert.rejects(adapter.observe(permission), /not installed/);
});
test('follow requires matching fresh observation; chat rejects server commands', async () => {
  const { adapter, commands } = fixture();
  await assert.rejects(adapter.follow('Player', 500, permission), /observation/);
  await adapter.observe(permission);
  await adapter.follow('Player', 500, permission);
  await assert.rejects(adapter.chat('/op Player', permission), /plain/);
  assert.equal(commands.filter(x => x.type === 'follow').length, 1);
  assert.equal((await adapter.stop()).stopVerified, true);
});
test('revocation during authorization never sends delayed action', async () => {
  let release;
  const sent = [];
  const adapter = createMinecraftAdapter({ authorize: () => new Promise(resolve => { release = resolve; }), transport: { request: async command => { sent.push(command); return { ...command, stopped: true, heldControls: 0 }; } } });
  const pending = adapter.observe(permission);
  await adapter.stop();
  release(true);
  await assert.rejects(pending, /revoked/);
  assert.deepEqual(sent.map(x => x.type), ['stop']);
});
test('unverified stop is visible and rejected', async () => {
  const adapter = createMinecraftAdapter({ authorize: async () => true, transport: { request: async () => ({ stopped: true }) } });
  await assert.rejects(adapter.stop(), /acknowledged/);
  assert.equal(adapter.status().stopVerified, false);
});
