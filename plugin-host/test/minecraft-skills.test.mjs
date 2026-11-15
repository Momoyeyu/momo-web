import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSkill,skills} from '../src/minecraft-skills.mjs';
test('every nonrecursive skill can be used in a bounded plan',()=>{
 assert.deepEqual([...skills.plan.parameters.properties.steps.items.properties.skill.enum].sort(),Object.keys(skills).filter(name=>name!=='plan').sort());
});
test('strict typed contract covers vanilla interaction and finite local composition',()=>{
 validateSkill('navigate',{x:1,y:64,z:2,height:'surface'});
 assert.throws(()=>validateSkill('navigate',{x:1,y:64,z:2,height:'teleport'}),/Invalid/);
 validateSkill('mine',{x:1,y:64,z:2});
 validateSkill('plan',{steps:[{skill:'eat',args:{},when:{item:'minecraft:apple',count:1,test:'atLeast'},retries:2},{skill:'inventory',args:{screen:'PlayerScreenHandler',actions:[{slot:9,button:0,mode:'quickMove'}]}}]});
});
test('terrain adaptation is an explicit bounded navigation option, never an executable program',()=>{
 validateSkill('navigate',{x:1,y:64,z:2,terrain:'preserve'});
 validateSkill('navigate',{x:1,y:64,z:2,height:'surface',terrain:'adapt'});
 validateSkill('plan',{steps:[{skill:'navigate',args:{x:1,y:64,z:2,terrain:'adapt'}}]});
 for(const terrain of ['teleport','script',''])assert.throws(()=>validateSkill('navigate',{x:1,y:64,z:2,terrain}),/Invalid/);
 assert.throws(()=>validateSkill('navigate',{x:1,y:64,z:2,terrain:'adapt',script:'anything'}),/Invalid/);
});
test('unknown fields, nested programs, overlong plans and nonfinite values fail before transport',()=>{
 for(const [skill,args] of [['mine',{x:NaN,y:64,z:1}],['eat',{script:'run'}],['plan',{steps:[{skill:'plan',args:{steps:[]}}]}],['plan',{steps:Array(25).fill({skill:'eat',args:{}})}],['workstation',{screen:'MerchantScreenHandler',actions:[{slot:1,button:9,mode:'button'}]}]])assert.throws(()=>validateSkill(skill,args),/Invalid|Unsupported/);
 assert.throws(()=>validateSkill('bash',{command:'x'}),/Unsupported/);
});
test('pickup, wait for processing, and a bounded merchant trade have typed paths',()=>{
 validateSkill('wait',{ticks:40});
 validateSkill('waitFor',{item:'minecraft:potion',potion:'minecraft:swiftness',count:3,area:'screen',ticks:600});
 validateSkill('gather',{item:'minecraft:oak_log',count:4});
 validateSkill('pickup',{entityId:3});
 validateSkill('waitFor',{item:'minecraft:iron_ingot',count:1,area:'screen',ticks:1200});
 validateSkill('trade',{index:0,count:1});
});
test('anvil naming uses bounded text and the same finite plan interface',()=>{
 validateSkill('rename',{name:'momo の剣'});
 validateSkill('rename',{name:''});
 validateSkill('plan',{steps:[{skill:'rename',args:{name:'小小的冒险'}}]});
 for(const args of [{name:'x'.repeat(51)},{name:'line\nbreak'},{name:'momo',command:'anything'}])assert.throws(()=>validateSkill('rename',args),/Invalid/);
});
test('surface navigation does not invent an unused elevation; exact navigation still requires it',()=>{
 validateSkill('navigate',{x:1,z:2,height:'surface'});
 validateSkill('navigate',{x:1,y:64,z:2,height:'surface'});
 validateSkill('plan',{steps:[{skill:'navigate',args:{x:1,z:2,height:'surface',terrain:'adapt'}}]});
 for(const args of [{x:1,z:2},{x:1,z:2,height:'exact'},{x:1,z:2,height:'surface',y:NaN},{x:1,z:2,height:'surface',y:'64'}])assert.throws(()=>validateSkill('navigate',args),/Invalid/);
});
test('ordinary item preparation and nearby placement do not require inventory slot arithmetic',()=>{
 validateSkill('selectItem',{item:'minecraft:crafting_table'});
 validateSkill('selectItem',{item:'minecraft:iron_sword',hotbar:2});
 validateSkill('placeNearby',{item:'minecraft:crafting_table'});
 validateSkill('plan',{steps:[{skill:'selectItem',args:{item:'minecraft:torch'}},{skill:'placeNearby',args:{item:'minecraft:torch'}}]});
 for(const [name,args] of [['selectItem',{item:'minecraft:stone',hotbar:9}],['placeNearby',{item:'minecraft:stone',script:'x'}],['selectItem',{item:''}]])assert.throws(()=>validateSkill(name,args),/Invalid/);
});
test('a bounded declarative build is cells, not scripts or repeated support-face inputs',()=>{
 const cell={x:1,y:64,z:2,block:'minecraft:oak_planks'};
 validateSkill('build',{cells:[cell,{...cell,x:2}]});
 validateSkill('plan',{steps:[{skill:'build',args:{cells:[cell]}}]});
 for(const cells of [[],Array(33).fill(cell),[cell,cell],[cell,{...cell,x:18}]])assert.throws(()=>validateSkill('build',{cells}),/Invalid/);
 assert.throws(()=>validateSkill('build',{cells:[cell],script:'anything'}),/Invalid/);
});
test('continuous follow can specify a bounded duration while default follow needs no micro-polling',()=>{
 validateSkill('follow',{entityId:4});validateSkill('follow',{entityId:4,ticks:120});
 for(const ticks of [0,1801])assert.throws(()=>validateSkill('follow',{entityId:4,ticks}),/Invalid/);
});
test('invalid skill inputs identify a bounded field and expected contract without echoing values',()=>{
 assert.throws(()=>validateSkill('selectItem',{item:'minecraft:stone',hotbar:36}),error=>{
  assert.deepEqual(error.validation,{path:'args.hotbar',rule:'integer',minimum:0,maximum:8});return true;
 });
 assert.throws(()=>validateSkill('plan',{steps:Array(25).fill({skill:'eat',args:{}})}),error=>{
  assert.deepEqual(error.validation,{path:'args.steps',rule:'array',minimum:1,maximum:24});return true;
 });
 assert.throws(()=>validateSkill('plan',{steps:[{skill:'selectItem',args:{item:'minecraft:stone',hotbar:36}}]}),error=>{
  assert.equal(error.validation.path,'args.steps[0].args.hotbar');return true;
 });
 const secret='PRIVATE-INPUT-token';
 assert.throws(()=>validateSkill('selectItem',{item:'minecraft:stone',hotbar:secret}),error=>{
  assert.equal(JSON.stringify(error.validation).includes(secret),false);return true;
 });
});
