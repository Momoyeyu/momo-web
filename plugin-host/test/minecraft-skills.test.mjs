import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSkill,skills} from '../src/minecraft-skills.mjs';
test('every nonrecursive skill can be used in a bounded plan',()=>{
 assert.deepEqual([...skills.plan.parameters.properties.steps.items.properties.skill.enum].sort(),Object.keys(skills).filter(name=>name!=='plan').sort());
});
test('strict typed contract covers vanilla interaction and finite local composition',()=>{
 validateSkill('mine',{x:1,y:64,z:2});
 validateSkill('plan',{steps:[{skill:'eat',args:{},when:{item:'minecraft:apple',count:1,test:'atLeast'},retries:2},{skill:'inventory',args:{screen:'PlayerScreenHandler',actions:[{slot:9,button:0,mode:'quickMove'}]}}]});
});
test('unknown fields, nested programs, overlong plans and nonfinite values fail before transport',()=>{
 for(const [skill,args] of [['mine',{x:NaN,y:64,z:1}],['eat',{script:'run'}],['plan',{steps:[{skill:'plan',args:{steps:[]}}]}],['plan',{steps:Array(25).fill({skill:'eat',args:{}})}],['workstation',{screen:'MerchantScreenHandler',actions:[{slot:1,button:9,mode:'button'}]}]])assert.throws(()=>validateSkill(skill,args),/Invalid|Unsupported/);
 assert.throws(()=>validateSkill('bash',{command:'x'}),/Unsupported/);
});
test('pickup, wait for processing, and a bounded merchant trade have typed paths',()=>{
 validateSkill('gather',{item:'minecraft:oak_log',count:4});
 validateSkill('pickup',{entityId:3});
 validateSkill('waitFor',{item:'minecraft:iron_ingot',count:1,area:'screen',ticks:1200});
 validateSkill('trade',{index:0,count:1});
});
