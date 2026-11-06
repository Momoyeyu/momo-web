import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeControl} from '../src/native-control.mjs';
const target={windowId:1,ownerPid:99,bundleId:'test.app',path:'/Applications/Test.app',bounds:{x:0,y:0,width:100,height:100}};
test('selected identity and fresh observation gate input; stop revokes',async()=>{
 let current={...target};const actions=[];let allowed=true;
 const broker=new NativeControl(()=>{if(!allowed)throw Error('REVOKED');},async input=>{if(input.action==='targets')return {targets:[current]};actions.push(input);return {executed:true};});
 const {bindingId}=await broker.start({...target,permissions:['observe','interact'],permit:{}});
 await assert.rejects(broker.action({action:'click',x:1,y:1},{},0,bindingId),/STALE/);
 broker.version=2;broker.observed=Date.now();
 await broker.action({action:'type',text:'hello'},{},2,bindingId);
 assert.equal(actions[0].ownerPid,99);
 current={...target,bounds:{...target.bounds,x:10}};
 await assert.rejects(broker.action({action:'click',x:1,y:1},{},3,bindingId),/MOVED/);
 current={...target,path:'/Applications/Replaced.app'};
 await assert.rejects(broker.action({action:'click',x:1,y:1},{},3,bindingId),/GONE/);
 await broker.stop();allowed=false;
 await assert.rejects(broker.observe({}),/REVOKED/);
});
test('late start after stop cannot restore a binding',async()=>{
 let release;const broker=new NativeControl(()=>{},()=>new Promise(resolve=>{release=resolve;}));
 const start=broker.start({...target,permissions:['observe'],permit:{}});
 await new Promise(resolve=>setImmediate(resolve));await broker.stop();release({targets:[target]});
 await assert.rejects(start,/REVOKED/);assert.equal(broker.binding,null);
});
test('legacy browser execution is retired and cannot start a Docker process',async()=>{
 const {PluginHost}=await import('../src/host.mjs');const host=new PluginHost();const token='native-regression-token'.repeat(3);
 await host.request({v:1,id:'hello',token,method:'hello',params:{coreInstance:'native-test',token}});
 await assert.rejects(host.request({v:1,id:'start',token,method:'browser.start',params:{}}),/existing browser/);
 await assert.rejects(host.request({v:1,id:'action',token,method:'browser.action',params:{}}),/existing browser/);
 assert.equal((await host.request({v:1,id:'stop',token,method:'browser.stop',params:{}})).stopped,true);
 await host.close();
});
test('native installed helper inventories current windows without input', {skip:!process.env.MOMO_NATIVE_CONTROL_EXECUTABLE},async()=>{
 const broker=new NativeControl(()=>{});const result=await broker.targets();
 assert.equal(typeof result.screenPermission,'boolean');assert.equal(typeof result.inputPermission,'boolean');assert.ok(Array.isArray(result.targets));
 for(const item of result.targets){assert.ok(Number.isInteger(item.windowId));assert.equal(typeof item.bundleId,'string');assert.equal(typeof item.path,'string');}
 await broker.stop();
});
test('a delayed old-binding action cannot target a replacement grant',async()=>{
 const calls=[];const broker=new NativeControl(()=>{},async input=>{calls.push(input);return {targets:[target]};});
 const old=await broker.start({...target,permissions:['observe','interact'],permit:{}});
 await broker.stop();const replacement=await broker.start({...target,permissions:['observe','interact'],permit:{}});
 assert.notEqual(old.bindingId,replacement.bindingId);broker.version=1;broker.observed=Date.now();
 const before=calls.length;
 await assert.rejects(broker.action({action:'type',text:'late'},{},1,old.bindingId),/UNAVAILABLE/);
 assert.equal(calls.length,before);await broker.stop();
});

test('native diagnostic allowlist never exposes helper text or paths',async()=>{
 const {nativeErrorCode}=await import('../src/native-control.mjs');
 assert.equal(nativeErrorCode(Error('SCREEN_PERMISSION_REQUIRED')),'SCREEN_PERMISSION_REQUIRED');
 assert.equal(nativeErrorCode(Error('STALE_OBSERVATION')),'STALE_OBSERVATION');
 assert.equal(nativeErrorCode(Error('/private/user token=secret')),'NATIVE_UNAVAILABLE');
});
