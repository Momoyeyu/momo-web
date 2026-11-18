import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../src/minecraft-skills.mjs';
import cases from './fixtures/minecraft-plan-origin.json' with {type:'json'};

test('a typed plan can validate shared-origin coordinates before ordinary world execution',()=>{
 for(const sample of cases){
  const input=structuredClone(sample.args);
  contract.validateSkill('plan',input);
  assert.deepEqual(contract.planSteps(input),sample.steps,sample.name);
  assert.deepEqual(input,sample.args,'Coordinate expansion must not rewrite the immutable original intention');
 }
});
test('origin expansion preserves world and existing per-part limits',()=>{
 const step={skill:'mine',args:{x:1,y:0,z:0}};
 for(const args of [
  {origin:{x:30000000,y:64,z:0},steps:[step]},
  {origin:{x:0,y:319,z:0},steps:[{...step,args:{x:0,y:1,z:0}}]},
  {origin:{x:0,y:64,z:0},steps:[{...step,args:{x:0,y:1.5,z:0}}]},
  {origin:{x:0,y:64,z:0},steps:[{skill:'build',args:{box:{x:0,y:0,z:0,width:6,height:1,length:6,block:'minecraft:dirt'}}}]},
  {origin:{x:0,y:64,z:0,script:'no'},steps:[step]},
  {origin:{x:0,y:64,z:0},mode:'script',steps:[step]},
  {origin:{x:0,y:64,z:0},steps:[{skill:'plan',args:{steps:[step]}}]},
 ])assert.throws(()=>contract.validateSkill('plan',args),/Invalid|Unsupported/);
});
