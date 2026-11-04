import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPrototype } from '../src/browser-prototype.mjs';

test('offline browser capture, bounded interaction and stop', { skip: process.env.BROWSER_PROBE_TEST !== '1' }, async () => {
  let allowed = true;
  const browser = new BrowserPrototype(() => { if (!allowed) throw new Error('REVOKED'); });
  await browser.start();
  try {
    let observation;
    for (let i=0; i<20; i++) {
      try { observation = await browser.action({ action:'observe' }, {}); break; }
      catch { await new Promise(resolve => setTimeout(resolve,250)); }
    }
    assert.ok(observation?.data);
    const loaded = await browser.action({action:'load',html:'<h1>Isolated fixture</h1><input style="position:absolute;left:10px;top:100px"><div style="height:2000px">Scroll target</div>'},{});
    const clicked = await browser.action({action:'click',x:50,y:110},{},loaded.version);
    const typed = await browser.action({action:'type',text:'fixture-only'},{},clicked.version);
    assert.notEqual(typed.data,loaded.data);
    await assert.rejects(browser.action({action:'scroll',delta:200},{},loaded.version),/STALE_OBSERVATION/);
    const scrolled = await browser.action({action:'scroll',delta:200},{},typed.version);
    assert.ok(scrolled.data);
    allowed = false;
    await assert.rejects(browser.action({action:'observe'},{}),/REVOKED/);
  } finally {
    assert.equal((await browser.stop()).stopped,true);
  }
});

test('Cordis browser permit and revoke stop the actual container', { skip: process.env.BROWSER_PROBE_TEST !== '1' }, async () => {
  const { PluginHost } = await import('../src/host.mjs');
  const host = new PluginHost();
  const token = 'isolated-fixture-token'.repeat(3);
  const request = (method,params={}) => host.request({v:1,id:crypto.randomUUID(),token,method,params});
  const hello = await request('hello',{coreInstance:'fixture',token,heartbeatMs:30000});
  await request('heartbeat',{activityEpoch:1});
  const permit = () => ({coreInstance:'fixture',hostInstance:hello.hostInstance,activityEpoch:1,runId:'fixture',commandId:crypto.randomUUID(),expiresAt:Date.now()+20000});
  try {
    await request('browser.start',{permit:permit()});
    assert.equal((await request('browser.status')).networkAvailable,false);
    let screenshot;
    for(let i=0;i<20;i++) {
      try { screenshot = await request('browser.action',{command:{action:'observe'},permit:permit()}); break; }
      catch { await new Promise(resolve => setTimeout(resolve,250)); }
    }
    assert.ok(screenshot?.data);
    assert.equal((await request('revoke',{activityEpoch:2})).stopped,true);
    assert.equal((await request('browser.status')).active,false);
    await assert.rejects(request('browser.action',{command:{action:'observe'},permit:permit()}));
  } finally { await host.close(); }
});

test('failed container removal can be retried without reactivating execution',async()=>{
 let attempts=0;
 const browser=new BrowserPrototype(()=>{},async args=>{
  assert.deepEqual(args.slice(0,2),['rm','-f']);
  if(++attempts===1)throw new Error('temporary daemon failure');
  return '';
 });
 browser.active=true;
 await assert.rejects(browser.stop(),/temporary daemon/);
 assert.equal(browser.active,false);
 assert.equal((await browser.stop()).stopped,true);
 assert.equal(attempts,2);
 await browser.stop();
 assert.equal(attempts,2);
});

test('semantic inspection finds named controls and scoped fill replaces text', { skip: process.env.BROWSER_PROBE_TEST !== '1' }, async () => {
  const browser = new BrowserPrototype(() => {});
  await browser.start();
  try {
    for (let i=0;i<20;i++) {
      try { await browser.action({action:'observe'},{}); break; }
      catch { await new Promise(resolve=>setTimeout(resolve,250)); }
    }
    await browser.action({action:'load',html:'<label>Search<input aria-label="Search" value="old"></label><button>Confirm</button>'},{});
    const inspected = await browser.action({action:'inspect'},{});
    const input=inspected.elements.find(e=>e.role==='textbox' && e.name==='Search');
    assert.ok(input?.id);
    assert.equal('backendNodeId' in input,false);
    assert.ok(inspected.elements.length<=60);
    const filled=await browser.action({action:'elementFill',elementId:input.id,text:'replacement'},{},inspected.version);
    assert.notEqual(filled.data,inspected.data);
    await assert.rejects(browser.action({action:'elementFill',elementId:input.id,text:'bad'},{},filled.version),/UNKNOWN_ELEMENT/);
    const fresh=await browser.action({action:'inspect'},{});
    const button=fresh.elements.find(e=>e.role==='button' && e.name==='Confirm');
    const clicked=await browser.action({action:'elementClick',elementId:button.id},{},fresh.version);
    assert.ok(clicked.data);
  } finally { await browser.stop(); }
});
