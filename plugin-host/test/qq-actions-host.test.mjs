import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PluginHost} from '../src/host.mjs';
import {ChannelError} from '../src/channels.mjs';

function setup(t,action){
 const host=new PluginHost();host.coreInstance='core';host.epoch=1;host.paused=false;host.lastHeartbeat=Date.now();
 const plugin={id:'momo-qq',config:{type:'qq',accountId:'qq-main',policyRevision:1},enabled:true,connected:true,controllers:new Set(),channel:{action,quarantined:false}};
 host.plugins.set(plugin.id,plugin);
 const permit={coreInstance:'core',hostInstance:host.hostInstance,activityEpoch:1,runId:'run',commandId:'command',expiresAt:Date.now()+10000};
 t.after(()=>{clearInterval(host.watchdog);host.plugins.clear();return host.close();});
 return {host,plugin,args:{pluginId:plugin.id,accountId:'qq-main',policyRevision:1,action:'contacts.list',arguments:{limit:10},permit}};
}
test('reviewed channel action needs actual permit/config and gives a correlated query receipt',async t=>{
 const {host,args}=setup(t,async(op,params,{beforeDispatch})=>{beforeDispatch();assert.equal(op,'contacts.list');return {items:[{peerId:'12345'}]};});
 const result=await host.actionChannel(args);assert.equal(result.receipt.status,'completed');assert.equal(result.receipt.kind,'channel.query');assert.equal(result.result.items[0].peerId,'12345');
 await assert.rejects(host.actionChannel(args),{code:'DUPLICATE_COMMAND'});
});
test('permission replacement during channel preparation blocks dispatch',async t=>{
 let nativeCalls=0;
 const {host,plugin,args}=setup(t,async(op,params,{beforeDispatch})=>{plugin.enabled=false;beforeDispatch();nativeCalls++;});
 await assert.rejects(host.actionChannel(args),{code:'STALE_CONFIG'});assert.equal(nativeCalls,0);
});
test('unknown friend approval preserves unknown operation without blind retry',async t=>{
 const {host,args}=setup(t,async()=>{throw new ChannelError('OUTCOME_UNKNOWN','unknown',true);});args.action='friends.respond';
 await assert.rejects(host.actionChannel(args),{code:'OUTCOME_UNKNOWN'});
 assert.equal(host.unresolved.size,1);assert.equal(host.commands.get('command').kind,'channel.send');
 assert.equal(host.receipts.at(-1).status,'unknown');assert.equal(host.paused,true);
});
