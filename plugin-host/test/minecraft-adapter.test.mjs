import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinecraftAdapter, createMinecraftTransport } from '../src/minecraft-adapter.mjs';
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

test('confirmed process exit releases an unreachable old client without inventing task receipts',async()=>{
 const adapter=createMinecraftAdapter({authorize:async()=>true,transport:{
  request:async()=>{throw new Error('Connection refused');},processExited:()=>true,
 }});
 const result=await adapter.stop();
 assert.equal(result.stopVerified,true);
 assert.equal(result.stopEvidence,'process_exited');
 assert.deepEqual(result.retiredTasks,[]);
});

test('exit during a failed request is proof, but an older stop cannot overwrite a newer acknowledgement',async()=>{
 let exited=false;
 const gone=createMinecraftAdapter({authorize:async()=>true,transport:{
  request:async()=>{exited=true;throw new Error('Disconnected');},processExited:()=>exited,
 }});
 assert.equal((await gone.stop()).stopEvidence,'process_exited');
 const pending=[];
 const adapter=createMinecraftAdapter({authorize:async()=>true,transport:{request:command=>new Promise(resolve=>pending.push({command,resolve}))}});
 const earlier=adapter.stop();const latest=adapter.stop();
 pending[1].resolve({...pending[1].command,stopped:true,heldControls:0});
 await latest;
 pending[0].resolve({...pending[0].command,stopped:true,heldControls:0});
 await assert.rejects(earlier,/Late/);
 assert.equal(adapter.status().stopVerified,true);
 assert.equal(adapter.status().stopEvidence,'bridge_ack');
});

test('a live or unidentified process still needs a real stop acknowledgement',async()=>{
 for(const processExited of [undefined,()=>false]){
  const adapter=createMinecraftAdapter({authorize:async()=>true,transport:{
   request:async()=>{throw new Error('Connection refused');},processExited,
  }});
  await assert.rejects(adapter.stop(),/Connection refused/);
  assert.equal(adapter.status().stopVerified,false);
 }
});

test('only ESRCH for the selected positive PID proves exit; access denied and unknown PID do not',()=>{
 const base={port:17649,token:'x'.repeat(40)};
 const exited=createMinecraftTransport({...base,pid:42,processProbe:(pid,signal)=>{
  assert.equal(pid,42);assert.equal(signal,0);throw Object.assign(new Error('gone'),{code:'ESRCH'});
 }});
 assert.equal(exited.processExited(),true);
 for(const code of [undefined,'EPERM','EINVAL']){
  const transport=createMinecraftTransport({...base,pid:42,processProbe:()=>{if(code)throw Object.assign(new Error('uncertain'),{code});}});
  assert.equal(transport.processExited(),false);
 }
 assert.equal(createMinecraftTransport(base).processExited(),false);
 for(const pid of [0,-1,1.5,'42'])assert.throws(()=>createMinecraftTransport({...base,pid}),/configuration/);
});

test('gameplay supports combined movement and rejects invalid input before dispatch', async () => {
  const { adapter, commands } = fixture();
  await adapter.observe(permission);
  await adapter.play({ control: 'mine', held: ['sneak'], durationMs: 4000 }, permission);
  assert.deepEqual(commands.at(-1).held, ['sneak']);
  assert.equal(commands.at(-1).type, 'play');
  const count = commands.length;
  await assert.rejects(adapter.play({ control: 'hotbar', slot: 9 }, permission), /Invalid gameplay/);
  await assert.rejects(adapter.play({ control: 'look', yaw: NaN }, permission), /Invalid gameplay/);
  await assert.rejects(adapter.play({ control: 'forward', held: ['command'] }, permission), /Invalid gameplay/);
  assert.equal(commands.length, count);
});

test('escape is a normal game key with the same observation and permission checks',async()=>{
 const {adapter,commands}=fixture();
 await assert.rejects(adapter.play({control:'screenKey',key:'escape',durationMs:1},permission),/observation/);
 assert.equal(commands.length,0);
 await adapter.observe(permission);
 await adapter.play({control:'screenKey',key:'escape',durationMs:1},permission);
 assert.equal(commands.at(-1).control,'screenKey');
 assert.equal(commands.at(-1).key,'escape');
 const count=commands.length;
 await assert.rejects(adapter.play({control:'screenKey',key:'command'},permission),/Invalid gameplay/);
 assert.equal(commands.length,count);
});

test('aim uses only the latest observed visible block and bounds pitch', async () => {
  const commands=[];
  const adapter=createMinecraftAdapter({now:()=>1000,authorize:async()=>true,transport:{request:async command=>{
    commands.push(command);return{...command,observedAt:1000,visibleBlocks:[{block:'minecraft:oak_log',lookYaw:35,lookPitch:-120}]};
  }}});
  await adapter.observe(permission);
  await adapter.play({control:'aim',blockIndex:0},permission);
  assert.equal(commands.at(-1).control,'look');
  assert.equal(commands.at(-1).yaw,35);
  assert.equal(commands.at(-1).pitch,-90);
  const count=commands.length;
  await assert.rejects(adapter.play({control:'aim',blockIndex:0},permission),/visible block/);
  assert.equal(commands.length,count);
  await adapter.observe(permission);
  await assert.rejects(adapter.play({control:'aim',blockIndex:1},permission),/visible block/);
});
