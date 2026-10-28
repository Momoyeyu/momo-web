import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QQChannel } from '../src/channels.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await wait(5); assert.ok(check()); }
const config = extra => ({ id: 'momo-qq', type: 'qq', transport: 'managed', accountId: 'qq-main', expectedSelfId: '123456', policyRevision: 2, permissions: { receive: true, reply: true }, allowlistEnabled: false, allowlist: [], timeoutMs: 80, ...extra });

class NativeFixture {
  selfId = '123456'; connected = true; reply = true;
  listeners = new Set(); calls = []; pending = new Set();
  status() { return { connected: this.connected, actualSelfId: this.selfId }; }
  onNativeEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  channelQuiescent() { return this.pending.size === 0; }
  event(value) { for (const listener of [...this.listeners]) listener(value); }
  async requestChannel(action, params, echo) {
    if (!this.connected) throw Object.assign(new Error('private native diagnostic'), { submitted: false });
    this.calls.push({ action, params, echo });
    if (action === 'get_login_info') queueMicrotask(() => this.event({ echo, status: 'ok', retcode: 0, data: { user_id: this.selfId } }));
    else {
      this.pending.add(echo);
      if (this.reply) queueMicrotask(() => this.complete(echo));
    }
    return { accepted: true };
  }
  complete(echo, success = true) {
    this.pending.delete(echo);
    this.event({ echo, status: success ? 'ok' : 'failed', retcode: success ? 0 : 1, data: { message_id: 'native-77' } });
  }
}

async function channel(t, { settings, ...options } = {}) {
  const native = new NativeFixture(), inbox = [], late = [];
  const adapter = new QQChannel(config(settings), { nativeRuntime: native, onInbox: value => inbox.push(value), onLateReceipt: value => late.push(value), ...options });
  t.after(() => adapter.close());
  await adapter.connect();
  return { native, adapter, inbox, late };
}

test('managed QQ uses authenticated native identity and fixed private text IPC without gateway settings', async t => {
  const { native, adapter } = await channel(t);
  assert.equal(adapter.health().status, 'connected');
  assert.equal(adapter.health().actualSelfId, '123456');
  let dispatched = 0;
  const receipt = await adapter.send({ peerId: '456789', text: '[CQ:at,qq=all] remains plain text', commandId: 'command-native', beforeDispatch: () => { dispatched++; } });
  assert.equal(dispatched, 1);
  assert.deepEqual(receipt, { deliveryStatus: 'provider_accepted', externalMessageId: 'native-77' });
  assert.deepEqual(native.calls.filter(call => call.action === 'send_private_msg').map(({ params }) => params), [{ user_id: '456789', message: '[CQ:at,qq=all] remains plain text' }]);
});

test('QQ refuses legacy external connection settings before creating a socket or using native IPC', async t => {
  let socketAttempts = 0;
  t.mock.method(globalThis, 'WebSocket', class { constructor() { socketAttempts++; throw new Error('legacy socket must never be created'); } });
  const cases = [
    { transport: undefined, endpoint: 'ws://127.0.0.1:3001', credential: { token: 'retired-secret' } },
    { transport: 'onebot', endpoint: 'ws://127.0.0.1:3001', credential: { token: 'retired-secret' } },
    { endpoint: 'ws://127.0.0.1:3001' },
    { credential: { token: 'retired-secret' } },
    { token: 'retired-secret' },
  ];
  for (const settings of cases) {
    const native = new NativeFixture(), adapter = new QQChannel(config(settings), { nativeRuntime: native });
    t.after(() => adapter.close());
    await assert.rejects(adapter.connect(), { code: 'CONFIG' });
    assert.equal(native.calls.length, 0);
    assert.equal(native.listeners.size, 0);
  }
  assert.equal(socketAttempts, 0);
});

test('managed private ingress preserves text-only scope, identity and the optional empty allowlist', async t => {
  const { native, adapter, inbox } = await channel(t);
  const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: '123456', user_id: '456789', message_id: 'native-message', time: 1770000000, message: [{ type: 'text', data: { text: 'hello momo' } }, { type: 'image', data: { file: 'ignored' } }] };
  native.event({ ...event, self_id: '99999' });
  native.event({ ...event, message_type: 'group' });
  native.event({ ...event, user_id: '123456' });
  assert.equal(inbox.length, 0);
  native.event(event);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].text, 'hello momo');
  assert.equal(inbox[0].policyRevision, 2);
  await adapter.ack(inbox[0].inboxId);
  adapter.config.allowlistEnabled = true;
  native.event({ ...event, message_id: 'next-message' });
  await assert.rejects(adapter.send({ peerId: '456789', text: 'not allowed' }), { code: 'FORBIDDEN' });
  assert.equal(inbox.length, 1);
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 0);
});

test('managed QQ never adopts an unbound or changed authenticated identity', async t => {
  const native = new NativeFixture();
  const adapter = new QQChannel(config({ expectedSelfId: '654321' }), { nativeRuntime: native });
  t.after(() => adapter.close());
  await assert.rejects(adapter.connect(), { code: 'ACCOUNT_MISMATCH' });
  const live = await channel(t);
  live.native.selfId = '654321';
  await assert.rejects(live.adapter.send({ peerId: '456789', text: 'wrong account' }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(live.native.calls.filter(call => call.action === 'send_private_msg').length, 0);
});

test('native control acknowledgement cannot complete a send; cancellation keeps the late provider fact', async t => {
  const { native, adapter, late } = await channel(t);
  native.reply = false;
  const controller = new AbortController();
  const pending = adapter.send({ peerId: '456789', text: 'once only', commandId: 'late-native', signal: controller.signal, beforeDispatch() {} });
  await until(() => native.calls.some(call => call.action === 'send_private_msg'));
  const echo = native.calls.find(call => call.action === 'send_private_msg').echo;
  controller.abort();
  await assert.rejects(pending, { code: 'OUTCOME_UNKNOWN', submitted: true });
  assert.equal((await adapter.stop()).executorQuiescent, false);
  assert.equal(adapter.health().executorQuiescent, false);
  assert.equal(late.length, 0);
  native.connected = false;
  native.complete(echo);
  assert.deepEqual(late, [{ commandId: 'late-native', status: 'completed', deliveryStatus: 'provider_accepted', externalMessageId: 'native-77' }]);
  assert.equal((await adapter.stop()).executorQuiescent, true);
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 1);
});

test('native adapter disposal withdraws ingress while retaining bounded correlation for already submitted work', async t => {
  const { native, adapter, late, inbox } = await channel(t);
  native.reply = false;
  const pending = adapter.send({ peerId: '456789', text: 'submitted before removal', commandId: 'closed-native', beforeDispatch() {} });
  await until(() => native.calls.some(call => call.action === 'send_private_msg'));
  const echo = native.calls.find(call => call.action === 'send_private_msg').echo;
  await adapter.close();
  await assert.rejects(pending, { code: 'OUTCOME_UNKNOWN', submitted: true });
  native.event({ post_type: 'message', message_type: 'private', self_id: '123456', user_id: '456789', message_id: 'discard-after-close', time: 1770000000, message: [{ type: 'text', data: { text: 'not admitted' } }] });
  assert.equal(inbox.length, 0);
  native.complete(echo);
  assert.equal(late.length, 1);
  assert.equal(late[0].commandId, 'closed-native');
  assert.equal(native.listeners.size, 0, 'the retained receipt subscription is released after the final correlation');
});

test('managed QQ checks the final dispatch gate and current authentication before writing a send', async t => {
  const { native, adapter } = await channel(t);
  await assert.rejects(adapter.send({ peerId: '456789', text: 'blocked', beforeDispatch: () => { throw new Error('revoked'); } }));
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 0);
  native.connected = false;
  assert.equal(adapter.health().status, 'disconnected');
  assert.equal(adapter.health().capabilities.reply, false);
  await assert.rejects(adapter.send({ peerId: '456789', text: 'disconnected', beforeDispatch() {} }), { submitted: false });
  assert.equal(native.calls.filter(call => call.action === 'send_private_msg').length, 0);
});

test('extended queries require their own grant and filter private indexes before projection',async t=>{
 const {native,adapter}=await channel(t,{settings:{permissions:{receive:true,reply:true,contacts:true,groups:true},allowlistEnabled:true,allowlist:['456789'],groupAllowlist:['777777']}});
 native.requestChannel=async function(action,params,echo){this.calls.push({action,params,echo});queueMicrotask(()=>this.event({echo,status:'ok',retcode:0,data:action==='get_login_info'?{user_id:this.selfId}:action==='contacts.list'?{contacts:[{peerId:'456789',name:'Allowed'},{peerId:'987654',name:'Private'}]}:{groups:[{peerId:'group:777777',name:'Allowed group'},{peerId:'group:888888',name:'Secret group'}]}}));};
 assert.deepEqual((await adapter.action('contacts.list',{})).contacts,[{peerId:'456789',name:'Allowed'}]);
 assert.deepEqual((await adapter.action('groups.list',{})).groups,[{peerId:'group:777777',name:'Allowed group'}]);
 const before=native.calls.length;await assert.rejects(adapter.action('history.list',{peerId:'456789'}),{code:'FORBIDDEN'});assert.equal(native.calls.length,before);
});

test('extended mutations keep native receipts, cancellation facts and final permission fences',async t=>{
 const {native,adapter,late}=await channel(t,{settings:{permissions:{receive:true,reply:true,proactive:true,groups:true,groupManagement:true},proactivePolicy:{recipientIds:['456789'],maxPerHour:6,quietStart:0,quietEnd:0},groupAllowlist:['777777']}});
 native.reply=false;const controller=new AbortController();
 const pending=adapter.action('private.send',{peerId:'456789',text:'one send'},{signal:controller.signal,commandId:'proactive-once'});
 await until(()=>native.calls.some(call=>call.action==='private.send'));const echo=native.calls.find(call=>call.action==='private.send').echo;
 controller.abort();await assert.rejects(pending,{code:'OUTCOME_UNKNOWN',submitted:true});native.complete(echo);assert.equal(late[0].commandId,'proactive-once');
 const before=native.calls.filter(call=>call.action==='groups.manage').length;
 await assert.rejects(adapter.action('groups.manage',{peerId:'group:888888',operation:'muteAll',enabled:true}),{code:'FORBIDDEN'});
 assert.equal(native.calls.filter(call=>call.action==='groups.manage').length,before);
 adapter.config.permissions.proactive=false;await assert.rejects(adapter.action('private.send',{peerId:'456789',text:'revoked'}),{code:'FORBIDDEN'});
});

test('group and media ingress are separately scoped and carry exact fetch identifiers',async t=>{
 const {native,adapter,inbox}=await channel(t,{settings:{permissions:{receive:true,reply:true,groups:true,media:true},groupAllowlist:['777777']}});
 const event={post_type:'message',message_type:'group',self_id:'123456',user_id:'456789',group_id:'777777',message_id:'media-msg',time:100,message:[{type:'image',data:{message_id:'media-msg',element_id:'5',name:'photo.png',size:200}}]};
 native.event({...event,group_id:'888888'});assert.equal(inbox.length,0);
 native.event(event);assert.equal(inbox.length,1);assert.equal(inbox[0].peerId,'group:777777');assert.equal(inbox[0].groupId,'777777');assert.equal(inbox[0].senderId,'456789');assert.equal(inbox[0].attachments[0].elementId,'5');
 adapter.config.permissions.media=false;native.event({...event,message_id:'media-2'});assert.equal(inbox.length,1);
});

test('a proactive action rechecks quiet time after identity lookup and never dispatches late',async t=>{
 let now=new Date(2026,9,29,12,0).getTime();const {adapter,native}=await channel(t,{now:()=>now,settings:{permissions:{receive:true,reply:true,proactive:true},proactivePolicy:{recipientIds:['456789'],maxPerHour:1,quietStart:22,quietEnd:8}}});
 let finish;native.requestChannel=async function(action,params,echo){this.calls.push({action,params,echo});if(action==='get_login_info')finish=()=>this.event({echo,status:'ok',retcode:0,data:{user_id:this.selfId}});};
 const pending=adapter.action('private.send',{peerId:'456789',text:'too late'});await until(()=>!!finish);now=new Date(2026,9,29,23,0).getTime();finish();
 await assert.rejects(pending,{code:'FORBIDDEN'});assert.equal(native.calls.filter(call=>call.action==='private.send').length,0);
});

test('trusted same-conversation media replies need reply+media but no proactive grant',async t=>{
 const {adapter,native}=await channel(t,{settings:{permissions:{receive:true,reply:true,media:true,proactive:false}}});
 const params={peerId:'456789',name:'note.txt',mime:'text/plain',dataBase64:'YQ=='};
 await assert.rejects(adapter.action('media.send',params),{code:'FORBIDDEN'});
 const result=await adapter.action('media.send',params,{replyMode:true,beforeDispatch(){}});assert.equal(result.deliveryStatus,'provider_accepted');
 assert.equal(native.calls.filter(call=>call.action==='media.send').length,1);assert.equal(adapter.proactiveAdmissions.length,0);
 adapter.config.permissions.reply=false;await assert.rejects(adapter.action('media.send',params,{replyMode:true}),{code:'FORBIDDEN'});
});

test('proactive minimum interval starts at the previous native dispatch',async t=>{
 let now=12000;
 const {adapter,native}=await channel(t,{now:()=>now,settings:{permissions:{receive:true,reply:true,proactive:true},proactivePolicy:{recipientIds:['456789'],maxPerHour:6,minIntervalSeconds:60,quietStart:0,quietEnd:0}}});
 await adapter.action('private.send',{peerId:'456789',text:'first after asynchronous identity verification'});
 now=60000;
 await assert.rejects(adapter.action('private.send',{peerId:'456789',text:'only 48 seconds after dispatch'}),{code:'FORBIDDEN'});
 assert.equal(native.calls.filter(call=>call.action==='private.send').length,1);
});

test('adapter-owned list scopes cannot be replaced with a caller-provided scope',async t=>{
 const {adapter,native}=await channel(t,{settings:{permissions:{receive:true,reply:true,contacts:true},allowlistEnabled:true,allowlist:['456789']}});
 const before=native.calls.length;await assert.rejects(adapter.action('contacts.list',{scopePeerIds:['987654']}),{code:'INPUT'});assert.equal(native.calls.length,before);
});

test('minimum intervals longer than the hourly quota window retain the last dispatch',async t=>{
 let now=12000;const {adapter}=await channel(t,{now:()=>now,settings:{permissions:{receive:true,reply:true,proactive:true},proactivePolicy:{recipientIds:['456789'],maxPerHour:6,minIntervalSeconds:10800,quietStart:0,quietEnd:0}}});
 await adapter.action('private.send',{peerId:'456789',text:'first'});now+=7200000;
 await assert.rejects(adapter.action('private.send',{peerId:'456789',text:'within three hour interval'}),{code:'FORBIDDEN'});
});
