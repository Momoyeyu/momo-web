import { test, expect, type Page } from './fixtures';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {waitForChatReady} from './helpers';

const backend = resolve(process.cwd(), '../backend');
type Result = {status:number; body:string; contentType:string; headers?:Record<string,string>};
let dir = '';
let child: ReturnType<typeof spawn>;
let queue: {resolve:(r:Result)=>void;reject:(e:Error)=>void}[] = [];
function call(path:string, method='GET', body?:unknown, real=false):Promise<Result> {
  return new Promise((resolve,reject) => {
    queue.push({resolve,reject});
    child.stdin!.write(JSON.stringify({directory:dir,path,method,body,real})+'\n');
  });
}
test.beforeEach(async ({page}) => {
  dir='';
  test.skip(test.info().title.startsWith('real model') && process.env.MOMO_REAL_LLM_E2E !== '1', 'Opt in: real provider');
  dir=mkdtempSync(join(tmpdir(),'momo-first-meeting-'));
  queue=[];
  child=spawn(join(backend,'.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),[join(backend,'tests/helpers/onboarding_request.py')],{env:{...process.env,PYTHONIOENCODING:'utf-8',MOMO_ONBOARDING_BRIDGE:'1'}});
  let buffer='', errors='';
  child.stdout!.on('data',bytes=>{
    buffer+=bytes;
    let nl:number;
    while((nl=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,nl); buffer=buffer.slice(nl+1);
      const next=queue.shift();
      try{next?.resolve(JSON.parse(line));}catch{next?.reject(new Error('Invalid test bridge result'));}
    }
  });
  child.stderr!.on('data',bytes=>errors+=bytes);
  child.on('close',()=>{for(const pending of queue.splice(0))pending.reject(new Error(errors||'Test bridge stopped'));});
  const real = test.info().title.startsWith('real model');
  await call('/api/state', 'GET', undefined, real);
  const state=JSON.parse((await call('/api/state')).body);
  if (!real) state.settings.llm={url:'https://api.deepseek.com',key:'test-only',model:'deepseek-chat',thinking:false};
  state.settings.general.voiceInput=false;
  // Mark the synthetic profile as established; opening must not hijack settings.
  await call('/api/state','PUT',state);
  await page.route('**/api/**',async route=>{
    const req=route.request();
    const result=await call(new URL(req.url()).pathname+new URL(req.url()).search,req.method(),req.postData()?req.postDataJSON():undefined);
    if(!page.isClosed())await route.fulfill({status:result.status,body:result.body,contentType:result.contentType,headers:result.headers});
  });
});
test.afterEach(async ({page})=>{
  if (!dir) return;
  await page.close();
  const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  child.stdin!.end();await closed;
  rmSync(dir,{recursive:true,force:true});
});
async function models(page:Page){
  await page.goto('/#/settings');
  await page.getByRole('button',{name:'模型',exact:true}).click();
  return page.locator('.settings-pane:not([aria-hidden]) .settings-cols');
}
test('only LLM and TTS remain, thinking persists, four rows align, and unknown providers disable thinking',async({page})=>{
  const pane=await models(page);
  await expect(pane.locator('section')).toHaveCount(2);
  await expect(pane).not.toContainText('Embedding');
  await expect(pane).not.toContainText('ASR');
  const cards=pane.locator('section');
  for(const card of await cards.all())await expect(card.locator('.opt-row')).toHaveCount(4);
  const boxes=await cards.evaluateAll(elements=>elements.map(el=>{const b=el.getBoundingClientRect();return {top:b.top,bottom:b.bottom};}));
  expect(Math.abs(boxes[0].top-boxes[1].top)).toBeLessThan(2);
  expect(Math.abs(boxes[0].bottom-boxes[1].bottom)).toBeLessThan(2);
  const thinking=page.getByRole('switch',{name:'思考模式',exact:true});
  await thinking.click();
  await expect(thinking).toHaveAttribute('aria-checked','true');
  await expect.poll(async()=>JSON.parse((await call('/api/state')).body).settings.llm.thinking).toBe(true);
  await page.reload();
  await page.getByRole('button',{name:'模型',exact:true}).click();
  await expect(thinking).toHaveAttribute('aria-checked','true');
  const first=page.locator('.settings-pane:not([aria-hidden]) section').first();
  await first.locator('.opt-row').first().locator('input').fill('https://other.example/v1');
  await expect(thinking).toBeDisabled();
  await expect(thinking).toHaveAttribute('aria-checked','false');
  await expect.poll(async()=>JSON.parse((await call('/api/state')).body).settings.llm.thinking).toBe(false);
  await page.screenshot({path:'../.workbuddy/004-008-009/settings-models.png'});
});
test('two model cards stay aligned and within a narrow stage in all interface languages',async({page})=>{
  await page.setViewportSize({width:800,height:450});
  await models(page);
  for(const [lang,label,thinking] of [['zh','模型','思考模式'],['en','Models','Thinking'],['ja','モデル','思考モード']]){
    const state=JSON.parse((await call('/api/state')).body);
    state.settings.general.lang=lang;
    await call('/api/state','PUT',state);
    await page.reload();
    await page.getByRole('button',{name:label,exact:true}).click();
    const sw=page.getByRole('switch',{name:thinking,exact:true});
    await sw.scrollIntoViewIfNeeded();
    await expect(sw).toBeInViewport();
    const pane=page.locator('.settings-pane:not([aria-hidden])');
    expect(await pane.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
    await expect(pane.locator('.settings-cols section')).toHaveCount(2);
  }
});

test('missing bundled resources give a recovery message without reintroducing configuration',async({page})=>{
  await page.route('**/api/resources/status',route=>route.fulfill({json:{asr:{ready:false},embedding:{state:'missing'},index:{state:'pending'}}}));
  await models(page);
  await expect(page.getByRole('status')).toContainText('重新安装完整应用');
  await expect(page.getByRole('status')).toContainText('当前使用文字匹配');
  await expect(page.locator('.settings-pane:not([aria-hidden]) .settings-cols section')).toHaveCount(2);
});

test('clicking the microphone twice during connection cancels pending activation',async({page})=>{
  const state=JSON.parse((await call('/api/state')).body);
  state.settings.general.voiceInput=true;
  await call('/api/state','PUT',state);
  await call('/api/onboarding','GET');
  // A completed synthetic conversation prevents the first-meeting overlay.
  await call('/api/onboarding/opening','POST');
  await page.route('**/api/onboarding',route=>route.fulfill({json:{stage:'completed',generation:0}}));
  await page.addInitScript(()=>{
    const Original=window.WebSocket;
    class PendingSocket {
      static OPEN=1;
      readyState=1; binaryType='';
      onmessage:((ev:{data:string})=>void)|null=null;
      onclose:((ev:{code:number})=>void)|null=null;
      constructor(url:string){
        if(!url.includes('/api/asr/stream'))return new Original(url) as unknown as PendingSocket;
        (window as unknown as {asrClosed:boolean}).asrClosed=false;
      }
      send(){}
      close(){this.readyState=3;(window as unknown as {asrClosed:boolean}).asrClosed=true;this.onclose?.({code:1000});}
    }
    window.WebSocket=PendingSocket as unknown as typeof WebSocket;
  });
  await page.goto('/#/chat');
  const mic=page.locator('.mic-btn');
  await expect(mic).toBeEnabled();
  await mic.click();
  await expect(mic).toHaveClass(/mic-on/);
  await mic.click();
  await expect(mic).not.toHaveClass(/mic-on/);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {asrClosed:boolean}).asrClosed)).toBe(true);
  await expect(mic).not.toHaveClass(/mic-on/);
});

for (const thinking of [false, true]) {
  test(`real model browser reply remains pure dialogue with thinking ${thinking ? 'on' : 'off'}`, async ({page}) => {
    test.setTimeout(120_000);
    const state=JSON.parse((await call('/api/state')).body);
    state.settings.llm.thinking=thinking;
    state.settings.general.textSpeed=100;
    state.settings.general.sentenceSpeed=100;
    await call('/api/state','PUT',state);
    await page.route('**/api/onboarding',route=>route.fulfill({json:{stage:'completed',generation:0}}));
    await page.goto('/#/chat');
    const input=page.locator('.input-row input');
    await expect(input).toBeVisible();
    await waitForChatReady(page);
    await input.fill('momo，我回来啦！今天路过甜品店，特意给你带了一块草莓蛋糕。');
    await input.press('Enter');
    await expect.poll(async()=>{
      const live=JSON.parse((await call('/api/checkpoints/live')).body);
      return live.messages.filter((row:{role:string})=>row.role==='assistant').map((row:{text:string})=>row.text).join('');
    },{timeout:90_000}).toContain('蛋糕');
    await expect(page.locator('.chat-error')).toHaveCount(0);
    await expect(page.locator('.subtitle')).not.toContainText('<|ACT');
    await expect(page.locator('.subtitle')).not.toContainText('reasoning_content');
    const live=(await call('/api/checkpoints/live')).body;
    expect(live).not.toContain('reasoning_content');
    expect(live).not.toContain('<|ACT');
    await page.goto('/#/backlog');
    await expect(page.locator('.bl-item.assistant').first()).toBeVisible();
    await expect(page.locator('.backlog-list')).not.toContainText('reasoning_content');
  });
}
