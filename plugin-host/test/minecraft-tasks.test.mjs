import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinecraftAdapter } from '../src/minecraft-adapter.mjs';
const permission={world:'test-world',account:'test-player',activityEpoch:1};
function fixture(){
 const commands=[];let allowed=true;
 const adapter=createMinecraftAdapter({authorize:async()=>allowed,transport:{request:async command=>{
  commands.push(command);
  return {...command,stopped:true,heldControls:0,taskProtocol:1,skills:['navigate'],accepted:true,task:{taskId:command.taskId,state:'queued',evidence:{}},events:{cursor:3,gap:false,events:[]}};
 }}});
 return {adapter,commands,revoke(){allowed=false;}};
}

test('continuous navigation returns acceptance immediately without a screenshot or duration wait',async()=>{
 const {adapter,commands}=fixture();
 await adapter.capabilities(permission);
 const result=await adapter.submit({taskId:'nav-1',skill:'navigate',args:{x:1,y:64,z:2}},permission);
 assert.equal(result.task.state,'queued');
 assert.equal(result.accepted,true);
 assert.equal(commands.at(-1).type,'submit');
 assert.equal(commands.at(-1).x,1);
 assert.equal(commands.at(-1).leaseMs,10000);
 assert.ok(!commands.some(c=>c.type==='observe'));
});

test('task payload rejects arbitrary code, identity overrides, and nonfinite coordinates',async()=>{
 const {adapter,commands}=fixture();await adapter.capabilities(permission);const count=commands.length;
 for(const args of [{x:NaN,y:64,z:2},{x:1,y:64,z:2,epoch:0},{x:1,y:64,z:2,script:'anything'}]){
  await assert.rejects(adapter.submit({taskId:'bad',skill:'navigate',args},permission),/Invalid/);
 }
 await assert.rejects(adapter.submit({taskId:'bad',skill:'bash',args:{}},permission),/Unsupported/);
 assert.equal(commands.length,count);
});

test('heartbeat and events use the same authority and stop remains usable after revocation',async()=>{
 const {adapter,commands,revoke}=fixture();await adapter.capabilities(permission);
 await adapter.heartbeat(permission);await adapter.events(0,permission);
 assert.equal(commands.at(-1).type,'events');assert.equal(commands.at(-1).after,0);
 revoke();const before=commands.filter(c=>c.type==='heartbeat').length;
 await assert.rejects(adapter.heartbeat(permission),/revoked/);
 assert.equal(commands.filter(c=>c.type==='heartbeat').length,before);
 await adapter.stop();assert.equal(adapter.status().stopVerified,true);
});

test('event cursors and task identifiers are checked before dispatch',async()=>{
 const {adapter,commands}=fixture();await adapter.capabilities(permission);const count=commands.length;
 await assert.rejects(adapter.events(-1,permission),/Invalid/);
 await assert.rejects(adapter.task('../other',permission),/Invalid/);
 await assert.rejects(adapter.cancel('',permission),/Invalid/);
 assert.equal(commands.length,count);
});

test('event polling and heartbeat do not wait for a model dispatch; revoke rejects the late task reply',async()=>{
 let resolveSubmit;let entered;
 const submitted=new Promise(resolve=>{entered=resolve;});
 const adapter=createMinecraftAdapter({authorize:async()=>true,transport:{request:async c=>{
  const result={...c,stopped:true,heldControls:0,taskProtocol:1,skills:['navigate']};
  if(c.type==='submit'){entered();await new Promise(resolve=>{resolveSubmit=resolve;});}
  return result;
 }}});
 await adapter.capabilities(permission);
 const task=adapter.submit({taskId:'queued',skill:'navigate',args:{x:1,y:64,z:2}},permission);
 await submitted;
 await adapter.heartbeat(permission);await adapter.events(0,permission);
 await adapter.stop();resolveSubmit();
 await assert.rejects(task,/Late/);
 assert.equal(adapter.status().stopped,true);
});
test('game chat cannot route raw Baritone commands around the knowledge boundary',async()=>{
 const {adapter,commands}=fixture();
 await assert.rejects(adapter.chat('#mine diamond_ore',permission),/plain/);
 assert.equal(commands.length,0);
});
