import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createNativeWorker } = require('../src/qq-native-worker.cjs');

function fixture() {
  const frames = [], calls = []; let loginListener, sessionListener, depends, msgListener;
  const profile = { getUinByUid: () => new Map([['u_self', '123456'], ['u_peer', '654321']]), getUidByUin: () => new Map([['654321', 'u_peer']]) };
  const buddy = { isBuddy: () => true };
  const msg = { addKernelMsgListener: value => { msgListener = value; }, generateMsgUniqueId: () => '90001', sendMsg: async (...args) => { calls.push(['send', ...args]); return { result: 0 }; } };
  const session = { init: (config, dependency, dispatcher, listener) => { calls.push(['session', config]); depends=dependency; sessionListener=listener; }, getProfileService: () => profile, getBuddyService: () => buddy, getMsgService: () => msg, getMSFService: () => ({ getServerTime: () => '1000' }) };
  const login = { initConfig: config => calls.push(['login', config]), addKernelLoginListener: listener => { loginListener=listener; }, connect: () => { calls.push(['connect']); queueMicrotask(() => loginListener.onLoginConnected()); return true; }, getQRCodePicture: () => { calls.push(['qr']); return true; }, abortPolling: () => {}, cancel: () => {}, getMachineGuid: () => '0123456789abcdef0123456789abcdef' };
  const api = { NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig: config => calls.push(['engine', config]) }) }, NodeIKernelLoginService: { get: () => login }, NodeIQQNTStartupSessionWrapper: { create: () => ({ start: () => calls.push(['start']) }) }, NodeIQQNTWrapperSession: { getNTWrapperSession: () => session } };
  const worker = createNativeWorker({ api, dataRoot: '/private/tmp/momo-worker-test', send: frame => frames.push(frame), now: () => 1000 });
  const auth = async () => { await worker.request('prepare', { attemptId: 'a' }); await worker.request('connect', { attemptId: 'a' }); loginListener.onQRCodeLoginSucceed({ uin: '123456', uid: 'u_self' }); await new Promise(r=>setImmediate(r)); sessionListener.onOpentelemetryInit({ is_init: true }); depends.onMSFStatusChange(2, 1); await new Promise(resolve => setImmediate(resolve)); };
  return { worker, frames, calls, profile, buddy, msg, nativeLogin:login, nativeSession:session, login: () => loginListener, session: () => sessionListener, depends: () => depends, messages: () => msgListener, auth };
}
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
test('authentication requires session readiness, native online state and mapped self identity', async () => {
  const f=fixture(); await f.worker.request('prepare',{attemptId:'a'}); await f.worker.request('connect',{attemptId:'a'});
  f.login().onQRCodeLoginSucceed({uin:'123456',uid:'u_self'}); await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.some(f=>f.event==='connected'),false);
  f.session().onOpentelemetryInit({is_init:true}); await Promise.resolve(); assert.equal(f.frames.some(f=>f.event==='connected'),false);
  f.depends().onMSFStatusChange(2,1); await new Promise(r=>setImmediate(r));
  assert.equal(f.frames.find(f=>f.event==='connected').data.selfId,'123456');
  assert.equal(f.calls.find(c=>c[0]==='session')[1].desktopPathConfig.account_path,'/private/tmp/momo-worker-test');
});
test('private text ingress rejects groups, self echoes and mixed or mismatched audiences', async () => {
  const f=fixture(); await f.auth(); const base={chatType:1,peerUin:'654321',senderUin:'654321',peerUid:'u_peer',senderUid:'u_peer',msgId:'100',msgTime:'1',elements:[{elementType:1,textElement:{content:'hello'}}]};
  f.messages().onRecvMsg([base,{...base,msgId:'101',chatType:2},{...base,msgId:'102',senderUin:'123456'},{...base,msgId:'103',elements:[{elementType:3}]}]);
  const inbox=f.frames.filter(f=>f.event==='onebot'&&f.data.post_type==='message'); assert.equal(inbox.length,1); assert.equal(inbox[0].data.raw_message,'hello');
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
test('disconnect during identity lookup cannot authenticate a stale online snapshot', async () => {
  const f=fixture();let resolve;
  f.profile.getUinByUid=()=>new Promise(r=>{resolve=r;});
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
  const f=fixture();let resolve;
  f.nativeSession.getMSFService=()=>({getMsfStatus:()=>2});
  f.profile.getUinByUid=()=>new Promise(r=>{resolve=r;});
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
