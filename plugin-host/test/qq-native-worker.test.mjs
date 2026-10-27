import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createNativeWorker } = require('../src/qq-native-worker.cjs');

function fixture({onIdentity} = {}) {
  const frames = [], calls = []; let loginListener, sessionListener, depends, msgListener;
  const profile = { getUinByUid: () => new Map([['u_self', '123456'], ['u_peer', '654321']]), getUidByUin: () => new Map([['654321', 'u_peer']]) };
  const buddy = { isBuddy: () => true };
  const uix = { getUin: () => ({ uinInfo: new Map([['u_peer', '654321']]) }) };
  const msg = { addKernelMsgListener: value => { msgListener = value; }, generateMsgUniqueId: () => '90001', sendMsg: async (...args) => { calls.push(['send', ...args]); return { result: 0 }; } };
  const session = { init: (config, dependency, dispatcher, listener) => { calls.push(['session', config]); depends=dependency; sessionListener=listener; }, getUixConvertService: () => uix, getProfileService: () => profile, getBuddyService: () => buddy, getMsgService: () => msg, getMSFService: () => ({ getServerTime: () => '1000' }) };
  const login = { initConfig: config => calls.push(['login', config]), addKernelLoginListener: listener => { loginListener=listener; }, connect: () => { calls.push(['connect']); queueMicrotask(() => loginListener.onLoginConnected()); return true; }, getQRCodePicture: () => { calls.push(['qr']); return true; }, abortPolling: () => {}, cancel: () => {}, getMachineGuid: () => '0123456789abcdef0123456789abcdef' };
  const nativeStartup = { start: () => calls.push(['start']) };
  const api = { NodeIO3MiscService: {get:()=>({addO3MiscListener:listener=>calls.push(['dispatcher',listener])})}, NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig: config => calls.push(['engine', config]) }) }, NodeIKernelLoginService: { get: () => login }, NodeIQQNTStartupSessionWrapper: { create: () => nativeStartup }, NodeIQQNTWrapperSession: { getNTWrapperSession: () => session } };
  const worker = createNativeWorker({ api, dataRoot: '/private/tmp/momo-worker-test', send: frame => frames.push(frame), now: () => 1000, onIdentity });
  const auth = async () => { await worker.request('prepare', { attemptId: 'a' }); await worker.request('connect', { attemptId: 'a' }); loginListener.onQRCodeLoginSucceed({ uin: '123456', uid: 'u_self' }); await new Promise(r=>setImmediate(r)); sessionListener.onOpentelemetryInit({ is_init: true }); depends.onMSFStatusChange(2, 1); await new Promise(resolve => setImmediate(resolve)); };
  return { worker, frames, calls, profile, buddy, uix, msg, nativeStartup, nativeLogin:login, nativeSession:session, login: () => loginListener, session: () => sessionListener, depends: () => depends, messages: () => msgListener, auth };
}
const inboundRecord=(overrides={})=>({chatType:1,peerUid:'u_peer',senderUid:'u_peer',msgId:'100',msgTime:'1',elements:[{elementType:1,textElement:{content:'private-text'}}],...overrides});
const inboundEvents=f=>f.frames.filter(frame=>frame.event==='onebot'&&frame.data.post_type==='message');
test('UID-only private messages resolve missing, empty and zero UINs using the native UixConvert map',async()=>{
  const f=fixture();await f.auth();let lookups=0;
  f.uix.getUin=uids=>{lookups++;assert.deepEqual(uids,['u_peer']);return{uinInfo:new Map([['u_peer','654321']])};};
  for(const [index,value] of [undefined,'','0','000'].entries())f.messages().onRecvMsg([inboundRecord({msgId:String(100+index),senderUin:value,peerUin:value})]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(lookups,4);assert.equal(inboundEvents(f).length,4);
  assert.ok(inboundEvents(f).every(frame=>frame.data.user_id==='654321'&&frame.data.sender.user_id==='654321'));
});
test('UID normalization preserves callback order and snapshots text before asynchronous resolution',async()=>{
  const f=fixture();await f.auth();let finish;
  f.uix.getUin=()=>new Promise(resolve=>{finish=resolve;});
  const first=inboundRecord({elements:[{elementType:1,textElement:{content:'first'}}]});
  f.messages().onRecvMsg([first]);
  f.messages().onRecvMsg([inboundRecord({msgId:'101',peerUin:'654321',senderUin:'654321',elements:[{elementType:1,textElement:{content:'second'}}]})]);
  assert.equal(inboundEvents(f).length,0);
  first.elements[0].textElement.content='mutated-after-callback';
  finish({uinInfo:new Map([['u_peer','654321']])});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(inboundEvents(f).map(frame=>frame.data.raw_message),['first','second']);
});
test('UID normalization rejects malformed mappings and conflicting or untrusted identities',async()=>{
  const cases=[
    {result:{}},{result:{uinInfo:new Map()}},{result:{uinInfo:new Map([['u_other','654321']])}},
    {result:{uinInfo:new Map([['u_peer',654321]])}},{result:{uinInfo:new Map([['u_peer','123456']])}},
    {record:{peerUin:'111111'}},{record:{senderUin:654321}},{record:{peerUin:null}},
    {record:{senderUid:'u_other'}},{record:{chatType:2}},{friend:false},
  ];
  for(const item of cases){
    const f=fixture();await f.auth();
    f.uix.getUin=()=>item.result??{uinInfo:new Map([['u_peer','654321']])};
    if(item.friend===false)f.buddy.isBuddy=()=>false;
    f.messages().onRecvMsg([inboundRecord(item.record)]);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(inboundEvents(f).length,0);
  }
});
test('UID lookup completion rechecks cancellation and friendship before any delivery',async()=>{
  for(const revoke of ['cancel','friend']){
    const f=fixture();await f.auth();let finish;
    f.uix.getUin=()=>new Promise(resolve=>{finish=resolve;});
    f.messages().onRecvMsg([inboundRecord()]);
    if(revoke==='cancel')await f.worker.request('cancel',{attemptId:'a'});else f.buddy.isBuddy=()=>false;
    finish({uinInfo:new Map([['u_peer','654321']])});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(inboundEvents(f).length,0);
  }
});
test('a pending UID lookup has a bounded ordered message queue without leaking native text',async()=>{
  const f=fixture();await f.auth();let finish,lookups=0;
  const pending=new Promise(resolve=>{finish=resolve;});
  f.uix.getUin=()=>{lookups++;return pending;};
  f.messages().onRecvMsg(Array.from({length:100},(_,index)=>inboundRecord({msgId:String(100+index)})));
  assert.equal(lookups,1);
  assert.ok(f.frames.some(frame=>frame.event==='diagnostic'&&frame.data.phase==='inbound_rejected'&&frame.data.code===12));
  finish({uinInfo:new Map([['u_peer','654321']])});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(inboundEvents(f).length,64);
  assert.ok(!JSON.stringify(f.frames.filter(frame=>frame.event==='diagnostic')).includes('private-text'));
});
test('UID lookup deadlines release later messages and ignore a late native map',async t=>{
  const f=fixture();await f.auth();let expire,finish;
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds)=>{assert.equal(milliseconds,10000);expire=callback;return{unref(){}};});
  f.uix.getUin=()=>new Promise(resolve=>{finish=resolve;});
  f.messages().onRecvMsg([inboundRecord(),inboundRecord({msgId:'101',peerUin:'654321',senderUin:'654321'})]);
  expire();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(inboundEvents(f).map(frame=>frame.data.message_id),['101']);
  finish({uinInfo:new Map([['u_peer','654321']])});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(inboundEvents(f).map(frame=>frame.data.message_id),['101']);
});
test('serialized UID lookups never reuse another contact identity or deduplicate another conversation',async()=>{
  const f=fixture();await f.auth();
  f.uix.getUin=([uid])=>({uinInfo:new Map([[uid,uid==='u_peer'?'654321':'765432']])});
  f.messages().onRecvMsg([inboundRecord(),inboundRecord({peerUid:'u_other',senderUid:'u_other'})]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(inboundEvents(f).map(frame=>frame.data.user_id),['654321','765432']);
});
test('a synchronous friendship callback cannot deliver a message after revoking the account',async()=>{
  const f=fixture();await f.auth();let checks=0;
  f.buddy.isBuddy=()=>{if(++checks===2)void f.worker.request('cancel',{attemptId:'a'});return true;};
  f.messages().onRecvMsg([inboundRecord()]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(inboundEvents(f).length,0);
});
test('prepare initializes only explicit private paths and does not connect or request a QR', async () => {
  const f=fixture(); await f.worker.request('prepare',{attemptId:'a'});
  assert.equal(f.calls.some(c=>['connect','qr'].includes(c[0])),false);
  assert.equal(f.calls.find(c=>c[0]==='engine')[1].global_path_config.desktopGlobalPath,'/private/tmp/momo-worker-test/global');
  assert.equal(f.calls.find(c=>c[0]==='login')[1].commonPath,'/private/tmp/momo-worker-test/global');
});
test('a native connection callback is not authentication; QR is explicit and PNG validated', async () => {
  const f=fixture(); await f.worker.request('prepare',{attemptId:'a'}); await f.worker.request('connect',{attemptId:'a'});
  assert.equal(f.frames.some(f=>f.event==='connected'),false); assert.equal(f.calls.some(c=>c[0]==='qr'),false);
  await f.worker.request('requestQr',{attemptId:'a'});
  f.login().onQRCodeGetPicture({pngBase64QrcodeData:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')});
  assert.equal(f.frames.at(-1).event,'qr'); assert.equal(f.frames.at(-1).data.attemptId,'a');
  f.login().onQRCodeGetPicture({pngBase64QrcodeData:Buffer.from('<svg/>').toString('base64')});
  assert.equal(f.frames.at(-1).data.status,'error');
});
test('one native process cannot reassign callback ownership to another attempt', async () => {
  const f=fixture(); await f.worker.request('prepare',{attemptId:'a'});
  await assert.rejects(f.worker.request('prepare',{attemptId:'b'}),e=>e.code==='FRESH_PROCESS_REQUIRED');
  await f.worker.request('cancel',{attemptId:'a'}); const count=f.frames.length;
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});
  assert.equal(f.frames.length,count);
});
test('native transport and generic session notifications alone cannot authenticate an account', async () => {
  const f=fixture(); await f.worker.request('prepare',{attemptId:'a'}); await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'}); await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.some(f=>f.event==='connected'),false);
  f.depends().onMSFStatusChange(2,1);f.session().onSessionInitComplete();await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.some(f=>f.event==='connected'),false);
  f.session().onOpentelemetryInit({is_init:true});await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.find(f=>f.event==='connected').data.selfId,'123456');
  assert.equal(f.calls.find(c=>c[0]==='session')[1].desktopPathConfig.account_path,'/private/tmp/momo-worker-test');
});
test('private text ingress rejects groups, self echoes and mixed or mismatched audiences', async () => {
  const f=fixture(); await f.auth(); const base={chatType:1,peerUin:'654321',senderUin:'654321',peerUid:'u_peer',senderUid:'u_peer',msgId:'100',msgTime:'1',elements:[{elementType:1,textElement:{content:'hello'}}]};
  f.messages().onRecvMsg([base,{...base,msgId:'101',chatType:2},{...base,msgId:'102',senderUin:'123456'},{...base,msgId:'103',elements:[{elementType:3}]}]);
  const inbox=f.frames.filter(f=>f.event==='onebot'&&f.data.post_type==='message'); assert.equal(inbox.length,1); assert.equal(inbox[0].data.raw_message,'hello');
});
test('native message listener supplies stable harmless callbacks for unused SDK slots', async () => {
  const f=fixture();await f.auth();
  assert.equal(typeof f.messages().onRecvMsgSvrRspTransInfo,'function');
  assert.equal(f.messages().onRecvMsgSvrRspTransInfo,f.messages().onRecvMsgSvrRspTransInfo);
  const before=f.frames.length;
  f.messages().onRecvMsgSvrRspTransInfo({private:'native-data'});
  assert.equal(f.frames.length,before);
});
test('a native send acceptance is not a delivery receipt; only matched server status confirms', async () => {
  const f=fixture(); await f.auth(); const request={action:'send_private_msg',echo:'command1',params:{user_id:'654321',message:'answer'}};
  await f.worker.request('onebot',request); assert.equal(f.frames.some(f=>f.event==='onebot'&&f.data.echo==='command1'),false);
  const send=f.calls.find(c=>c[0]==='send'); assert.equal(send[2].chatType,1); assert.equal(send[2].peerUid,'u_peer');
  f.messages().onMsgInfoListUpdate([{guildId:'90001',senderUid:'u_self',peerUid:'u_wrong',sendStatus:2,msgId:'88'}]);
  assert.equal(f.frames.some(f=>f.event==='onebot'&&f.data.echo==='command1'),false);
  f.messages().onMsgInfoListUpdate([{guildId:'90001',senderUid:'u_self',peerUid:'u_peer',sendStatus:2,msgId:'88'}]);
  assert.equal(f.frames.find(f=>f.event==='onebot'&&f.data.echo==='command1').data.data.message_id,'88');
  await f.worker.request('onebot',request); assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
});
test('a matched success wins over failure rows in either batch order, including after cancellation',async()=>{
  for(const statuses of [[0,2],[2,0]]){
    const f=fixture();await f.auth();
    await f.worker.request('onebot',{action:'send_private_msg',echo:'batch-receipt',params:{user_id:'654321',message:'answer'}});
    await f.worker.request('cancel',{attemptId:'a'});
    const rows=statuses.map(sendStatus=>({guildId:'90001',senderUid:'u_self',peerUid:'u_peer',sendStatus,msgId:'88'}));
    f.messages().onMsgInfoListUpdate(rows);
    f.messages().onMsgInfoListUpdate(rows);
    const receipts=f.frames.filter(frame=>frame.event==='onebot'&&frame.data.echo==='batch-receipt');
    assert.equal(receipts.length,1);assert.equal(receipts[0].data.status,'ok');
    assert.equal(receipts[0].data.data.message_id,'88');
  }
});
test('malformed or mismatched receipt rows cannot crash the listener or settle another send',async()=>{
  const f=fixture();await f.auth();
  await f.worker.request('onebot',{action:'send_private_msg',echo:'strict-receipt',params:{user_id:'654321',message:'answer'}});
  const valid={guildId:'90001',senderUid:'u_self',peerUid:'u_peer',sendStatus:2,msgId:'88'};
  const malicious={...valid};Object.defineProperty(malicious,'msgId',{get(){throw Error('private-receipt-detail');}});
  assert.doesNotThrow(()=>f.messages().onMsgInfoListUpdate([
    null,undefined,'invalid',[],malicious,
    {...valid,guildId:'another-command'},{...valid,senderUid:'u_other'},
    {...valid,peerUid:'u_other'},{...valid,chatType:2},{...valid,sendStatus:'2'},
    {...valid,msgId:null},{...valid,msgId:''},{...valid,msgId:'x'.repeat(201)},
    {...valid,senderUid:'u_other',sendStatus:0},
  ]));
  assert.equal(f.frames.some(frame=>frame.event==='onebot'&&frame.data.echo==='strict-receipt'),false);
  f.messages().onMsgInfoListUpdate([valid]);
  assert.equal(f.frames.find(frame=>frame.event==='onebot'&&frame.data.echo==='strict-receipt').data.data.message_id,'88');
  assert.equal(JSON.stringify(f.frames).includes('private-receipt-detail'),false);
});
test('the first valid matched success supplies the receipt and an isolated matched failure stays failure',async()=>{
  for(const success of [true,false]){
    const f=fixture();await f.auth();
    await f.worker.request('onebot',{action:'send_private_msg',echo:'terminal-receipt',params:{user_id:'654321',message:'answer'}});
    const row={guildId:'90001',senderUid:'u_self',peerUid:'u_peer',sendStatus:0};
    f.messages().onMsgInfoListUpdate(success?[row,{...row,sendStatus:2,msgId:'88'},{...row,sendStatus:2,msgId:'99'}]:[row]);
    const receipt=f.frames.find(frame=>frame.event==='onebot'&&frame.data.echo==='terminal-receipt').data;
    assert.equal(receipt.status,success?'ok':'failed');
    assert.deepEqual(receipt.data,success?{message_id:'88'}:{});
  }
});
test('cancellation during recipient lookup prevents native submission', async () => {
  const f=fixture(); await f.auth(); let resolve;
  f.profile.getUidByUin=()=>new Promise(r=>{resolve=r;});
  const pending=f.worker.request('onebot',{action:'send_private_msg',echo:'cancelled',params:{user_id:'654321',message:'answer'}});
  await new Promise(r=>setImmediate(r)); await f.worker.request('cancel',{attemptId:'a'});
  resolve(new Map([['654321','u_peer']]));
  await assert.rejects(pending,e=>e.code==='ATTEMPT_CANCELLED');
  assert.equal(f.calls.some(c=>c[0]==='send'),false);
});
test('no-sequence local acceptance cannot masquerade as a server delivery receipt', async () => {
  const f=fixture(); await f.auth();
  await f.worker.request('onebot',{action:'send_private_msg',echo:'pending',params:{user_id:'654321',message:'answer'}});
  f.messages().onMsgInfoListUpdate([{guildId:'90001',senderUid:'u_self',peerUid:'u_peer',sendStatus:3,msgId:'88'}]);
  assert.equal(f.frames.some(frame=>frame.event==='onebot'&&frame.data.echo==='pending'),false);
  await f.worker.request('cancel',{attemptId:'a'});
  f.messages().onMsgInfoListUpdate([{guildId:'90001',senderUid:'u_self',peerUid:'u_peer',sendStatus:2,msgId:'88'}]);
  assert.equal(f.frames.find(frame=>frame.event==='onebot'&&frame.data.echo==='pending').data.data.message_id,'88');
});
test('private cached login resumes only an explicitly pinned matching account', async () => {
  const f=fixture(); let attempted=0;
  f.nativeLogin.getLoginList=async()=>({LocalLoginInfoList:[{uin:'123456',uid:'u_self',isQuickLogin:true}]});
  f.nativeLogin.quickLoginWithUin=async uin=>{attempted++;assert.equal(uin,'123456');return{result:'0'};};
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});
  await f.worker.request('connect',{attemptId:'a'});
  await f.worker.request('requestQr',{attemptId:'a'});
  assert.equal(attempted,1); assert.equal(f.calls.some(c=>c[0]==='qr'),false);
  assert.equal(f.frames.some(frame=>frame.event==='connected'),false);
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(r=>setImmediate(r));
  f.session().onOpentelemetryInit({is_init:true});f.depends().onMSFStatusChange(2,1);await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.at(-1).data.selfId,'123456');
});
test('disconnect during the owned identity commit cannot authenticate a stale session', async () => {
  let resolve;const f=fixture({onIdentity:()=>new Promise(r=>{resolve=r;})});
  await f.auth();f.depends().onMSFStatusChange(1,2);
  resolve(new Map([['u_self','123456']]));await new Promise(r=>setImmediate(r));
  assert.equal((await f.worker.request('status')).connected,false);
  assert.equal(f.frames.some(frame=>frame.event==='connected'),false);
});
test('a malformed native submission result remains unknown until a genuine receipt', async () => {
  const f=fixture();await f.auth();f.msg.sendMsg=async()=>undefined;
  await f.worker.request('onebot',{action:'send_private_msg',echo:'ambiguous',params:{user_id:'654321',message:'answer'}});
  assert.equal(f.frames.some(frame=>frame.event==='onebot'&&frame.data.echo==='ambiguous'),false);
  f.messages().onMsgInfoListUpdate([{guildId:'90001',senderUid:'u_self',peerUid:'u_peer',sendStatus:2,msgId:'88'}]);
  assert.equal(f.frames.find(frame=>frame.event==='onebot'&&frame.data.echo==='ambiguous').data.data.message_id,'88');
});
test('private strangers and unavailable friendship checks cannot enter the brain or receive a send', async () => {
  for(const check of [()=>false,undefined,()=>{throw Error('unavailable');}]){
    const f=fixture();await f.auth();f.buddy.isBuddy=check;
    f.messages().onRecvMsg([{chatType:1,peerUin:'654321',senderUin:'654321',peerUid:'u_peer',senderUid:'u_peer',msgId:'100',msgTime:'1',elements:[{elementType:1,textElement:{content:'stranger'}}]}]);
    assert.equal(f.frames.some(frame=>frame.event==='onebot'&&frame.data.post_type==='message'),false);
    await assert.rejects(f.worker.request('onebot',{action:'send_private_msg',echo:'stranger',params:{user_id:'654321',message:'answer'}}),e=>e.code==='PEER_UNVERIFIED');
    assert.equal(f.calls.some(call=>call[0]==='send'),false);
  }
});
test('removing a friend during native correlation allocation prevents submission', async () => {
  const f=fixture();await f.auth();let resolve;
  f.msg.generateMsgUniqueId=()=>new Promise(r=>{resolve=r;});
  const pending=f.worker.request('onebot',{action:'send_private_msg',echo:'removed',params:{user_id:'654321',message:'answer'}});
  await new Promise(r=>setImmediate(r));f.buddy.isBuddy=()=>false;resolve('90001');
  await assert.rejects(pending,e=>e.code==='PEER_UNVERIFIED');
  assert.equal(f.calls.some(call=>call[0]==='send'),false);
});
test('phase diagnostics contain no native payload, account identity or QR material', async () => {
  const f=fixture();await f.auth();f.login().onLoginFailed({ticket:'private-test-ticket',message:'private-native-detail'});
  const events=f.frames.filter(frame=>frame.event==='diagnostic');
  assert.ok(events.some(frame=>frame.data.phase==='session_init'));
  assert.ok(events.some(frame=>frame.data.phase==='identity_end'));
  assert.ok(events.every(frame=>Object.keys(frame.data).every(key=>['attemptId','phase','elapsedMs','code'].includes(key))));
  assert.ok(!/private-test-ticket|private-native-detail|123456|u_self|base64/.test(JSON.stringify(events)));
});

const withinControlDeadline = promise => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('transport ACK waited for cached login')), 30))]);
test('cached-list recovery cannot hold the transport ACK or start a QR beside pending recovery', async () => {
  const f=fixture();let resolve;
  f.nativeLogin.getLoginList=()=>new Promise(r=>{resolve=r;});
  f.nativeLogin.quickLoginWithUin=()=>{throw new Error('cancelled recovery must not run');};
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});
  await withinControlDeadline(f.worker.request('connect',{attemptId:'a'}));
  await f.worker.request('requestQr',{attemptId:'a'});
  assert.equal(f.calls.some(c=>c[0]==='qr'),false);
  await f.worker.request('cancel',{attemptId:'a'});
  resolve({LocalLoginInfoList:[{uin:'123456',uid:'u_self',isQuickLogin:true}]});
  await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.some(frame=>frame.event==='connected'),false);
});
test('a pending quick-login promise cannot block a genuine native authentication callback', async () => {
  const f=fixture();
  f.nativeLogin.getLoginList=async()=>({LocalLoginInfoList:[{uin:'123456',uid:'u_self',isQuickLogin:true}]});
  f.nativeLogin.quickLoginWithUin=()=>new Promise(()=>{});
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});
  await withinControlDeadline(f.worker.request('connect',{attemptId:'a'}));
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(r=>setImmediate(r));
  f.session().onOpentelemetryInit({is_init:true});f.depends().onMSFStatusChange(2,1);
  await new Promise(r=>setImmediate(r));
  assert.equal((await f.worker.request('status')).connected,true);
});
test('explicit fresh QR never starts cached login and duplicate transport callbacks do not re-request it', async () => {
  const f=fixture();let cacheCalls=0;
  f.nativeLogin.getLoginList=()=>{cacheCalls++;return new Promise(()=>{});};
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456',restoreSession:false});
  await withinControlDeadline(f.worker.request('connect',{attemptId:'a'}));
  await f.worker.request('requestQr',{attemptId:'a'});f.login().onLoginConnected();
  await f.worker.request('requestQr',{attemptId:'a'});
  assert.equal(cacheCalls,0);assert.equal(f.calls.filter(c=>c[0]==='qr').length,1);
});
test('cached acceptance alone does not prove the authenticated account identity', async () => {
  const f=fixture();
  f.nativeLogin.getLoginList=async()=>({LocalLoginInfoList:[{uin:'123456',uid:'u_self',isQuickLogin:true}]});
  f.nativeLogin.quickLoginWithUin=async()=>({result:'0'});
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});
  await f.worker.request('connect',{attemptId:'a'});await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.some(c=>c[0]==='session'),false);
});
test('an explicit offline notification wins over a stale native status getter', async () => {
  let resolve;const f=fixture({onIdentity:()=>new Promise(r=>{resolve=r;})});
  f.nativeSession.getMSFService=()=>({getMsfStatus:()=>2});
  await f.auth();f.depends().onMSFStatusChange(1,2);
  resolve(new Map([['u_self','123456']]));await new Promise(r=>setImmediate(r));
  assert.equal((await f.worker.request('status')).connected,false);
});
test('native success callback unwinds before session initialization and cancellation can withdraw it', async () => {
  const f=fixture();
  await f.worker.request('prepare',{attemptId:'a'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});
  assert.equal(f.calls.some(c=>c[0]==='session'),false);
  await f.worker.request('cancel',{attemptId:'a'});await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.some(c=>c[0]==='session'),false);
});
test('late QR and scan callbacks cannot demote an authenticated initialization', async () => {
  const f=fixture();await f.worker.request('prepare',{attemptId:'a'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});
  const count=f.frames.length;
  f.login().onQRCodeSessionUserScaned();
  f.login().onQRCodeGetPicture({pngBase64QrcodeData:Buffer.from([137,80,78,71,13,10,26,10,1]).toString('base64')});
  assert.equal(f.frames.length,count);
  await f.worker.request('cancel',{attemptId:'a'});
});
test('a quick-login error accompanying result zero falls back to a fresh QR without exposing the error', async () => {
  const f=fixture();
  f.nativeLogin.getLoginList=async()=>({LocalLoginInfoList:[{uin:'123456',uid:'u_self',isQuickLogin:true}]});
  f.nativeLogin.quickLoginWithUin=async()=>({result:'0',loginErrorInfo:{errMsg:'private native explanation'}});
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});
  await f.worker.request('connect',{attemptId:'a'});await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.filter(c=>c[0]==='qr').length,1);
  assert.equal(JSON.stringify(f.frames).includes('private native explanation'),false);
});
test('genuine native authentication wins over a late cached-login error result', async () => {
  const f=fixture();let resolve;
  f.nativeLogin.getLoginList=async()=>({LocalLoginInfoList:[{uin:'123456',uid:'u_self',isQuickLogin:true}]});
  f.nativeLogin.quickLoginWithUin=()=>new Promise(r=>{resolve=r;});
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});
  await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});
  resolve({result:'0',loginErrorInfo:{errMsg:'private late explanation'}});await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.some(c=>c[0]==='qr'),false);
  await f.worker.request('cancel',{attemptId:'a'});
});

test('native event dispatcher is registered before engine initialization and does not manufacture O3 data', async () => {
  const f=fixture();await f.worker.request('prepare',{attemptId:'a'});
  const dispatcher=f.calls.findIndex(c=>c[0]==='dispatcher'),engine=f.calls.findIndex(c=>c[0]==='engine');
  assert.ok(dispatcher>=0&&dispatcher<engine);
  assert.deepEqual(Object.keys(f.calls[dispatcher][1]),['getOnAmgomDataPiece']);
  assert.equal(f.calls[dispatcher][1].getOnAmgomDataPiece(),undefined);
});

test('native account readiness does not require finding self in the friend cache or an initial MSF-connected callback', async () => {
  const f=fixture();f.profile.getUinByUid=()=>{throw Error('friend cache is not self identity');};
  await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(r=>setImmediate(r));
  f.depends().onMSFStatusChange(1,0);f.session().onSessionInitComplete();await new Promise(r=>setImmediate(r));
  assert.equal((await f.worker.request('status')).connected,false,'session notification alone is not native readiness');
  f.session().onOpentelemetryInit({is_init:true});await new Promise(r=>setImmediate(r));
  assert.equal((await f.worker.request('status')).connected,true);
  await f.worker.request('onebot',{action:'get_login_info',echo:'self'});
  assert.equal(f.frames.find(x=>x.event==='onebot'&&x.data.echo==='self').data.data.user_id,'123456');
});
test('positive native readiness cannot overtake a pending startup return', async () => {
  const f=fixture();let finish;f.nativeStartup.start=()=>new Promise(r=>{finish=r;});
  await f.worker.request('prepare',{attemptId:'a'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(r=>setImmediate(r));
  f.session().onOpentelemetryInit({is_init:true});f.depends().onMSFStatusChange(2,1);await new Promise(r=>setImmediate(r));
  assert.equal((await f.worker.request('status')).connected,false);
  finish();await new Promise(r=>setImmediate(r));assert.equal((await f.worker.request('status')).connected,true);
});
test('native startup rejection never publishes a connected account', async () => {
  const f=fixture();let reject;f.nativeStartup.start=()=>new Promise((_,r)=>{reject=r;});
  await f.worker.request('prepare',{attemptId:'a'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(r=>setImmediate(r));
  f.session().onOpentelemetryInit({is_init:true});reject(Error('private-start-detail'));await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.some(x=>x.event==='connected'),false);
  assert.equal(f.frames.filter(x=>x.event==='state').at(-1).data.status,'error');
  assert.equal(JSON.stringify(f.frames).includes('private-start-detail'),false);
});
test('a mismatched native login identity cannot initialize or publish a session', async () => {
  const f=fixture();await f.worker.request('prepare',{attemptId:'a',expectedSelfId:'123456'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'654321',uid:'u_peer'});await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.some(c=>c[0]==='session'),false);assert.equal(f.frames.some(x=>x.event==='connected'),false);
  assert.equal(f.frames.filter(x=>x.event==='state').at(-1).data.code,'ACCOUNT_MISMATCH');
});
test('synchronous native initialization failure withdraws startup before dispatch', async () => {
  const f=fixture();f.nativeSession.init=(_config,_depends,_dispatcher,listener)=>listener.onOpentelemetryInit({is_init:false});
  await f.worker.request('prepare',{attemptId:'a'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(r=>setImmediate(r));
  assert.equal(f.calls.some(c=>c[0]==='start'),false);
  assert.equal(f.frames.some(x=>x.event==='connected'),false);
});

test('cancellation fences a pending startup completion after positive native readiness', async () => {
  const f=fixture();let finish;
  f.nativeStartup.start=()=>new Promise(resolve=>{finish=resolve;});
  await f.worker.request('prepare',{attemptId:'a'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(resolve=>setImmediate(resolve));
  f.session().onOpentelemetryInit({is_init:true});
  assert.equal((await f.worker.request('status')).connected,false);
  await f.worker.request('cancel',{attemptId:'a'});
  finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.worker.request('status')).connected,false);
  assert.equal(f.frames.some(frame=>frame.event==='connected'),false);
  await assert.rejects(f.worker.request('onebot',{action:'get_login_info',echo:'cancelled-startup'}),{code:'PLUGIN_UNAVAILABLE'});
});

test('an initial-looking MSF snapshot after connection withdraws account access', async () => {
  const f=fixture();await f.worker.request('prepare',{attemptId:'a'});await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'});await new Promise(resolve=>setImmediate(resolve));
  f.depends().onMSFStatusChange(1,0);f.session().onOpentelemetryInit({is_init:true});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.worker.request('status')).connected,true);
  f.depends().onMSFStatusChange(1,0);await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.worker.request('status')).connected,false);
  assert.equal(f.frames.filter(frame=>frame.event==='state').at(-1).data.status,'disconnected');
  await assert.rejects(f.worker.request('onebot',{action:'get_login_info',echo:'offline'}),{code:'PLUGIN_UNAVAILABLE'});
});

test('cancellation before the awaited login-info reply emits no stale identity response', async () => {
  const f=fixture();await f.auth();
  const reply=f.worker.request('onebot',{action:'get_login_info',echo:'cancelled-identity'});
  assert.equal(f.frames.some(frame=>frame.event==='onebot'&&frame.data.echo==='cancelled-identity'),false);
  await f.worker.request('cancel',{attemptId:'a'});
  await assert.rejects(reply,{code:'ATTEMPT_CANCELLED'});
  assert.equal(f.frames.some(frame=>frame.event==='onebot'&&frame.data.echo==='cancelled-identity'),false);
});
