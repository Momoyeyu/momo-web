import {test,expect} from './fixtures';
import type {Page} from './fixtures';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const backend = resolve(process.cwd(), '../backend');
type Result = {status:number;body:string;contentType:string;headers?:Record<string,string>};
const workers = new Map<string, {child: ReturnType<typeof spawn>; queue:{accept:(r:Result)=>void;reject:(e:Error)=>void}[]}>();
function call(directory: string, path: string, method = 'GET', body?: unknown, options = {}): Promise<Result> {
  let worker = workers.get(directory);
  if (!worker) {
    const child = spawn(join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [join(backend, 'tests/helpers/onboarding_request.py')], {env:{...process.env, PYTHONIOENCODING:'utf-8', MOMO_ONBOARDING_BRIDGE:'1'}});
    worker = {child, queue:[]}; workers.set(directory, worker);
    const own = worker;
    let buffer = '', err = '';
    child.stdout!.on('data', b => {
      buffer += b;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        const pending = own.queue.shift();
        try {pending?.accept(JSON.parse(line));} catch {pending?.reject(new Error('Invalid isolated bridge result'));}
      }
    });
    child.stderr!.on('data', b => err += b);
    child.on('close', code => {for (const p of own.queue.splice(0)) p.reject(new Error(err || `Bridge closed: ${code}`));});
  }
  const own = worker;
  return new Promise((accept, reject) => {
    own.queue.push({accept, reject});
    own.child.stdin!.write(JSON.stringify({directory,path,method,body,...options})+'\n');
  });
}
async function bridge(page: Page, directory: string, options = {}) {
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (path === '/api/probe/llm') return route.fulfill({json: {ok: true, detail: '1ms'}});
    if (!path.startsWith('/api/intro') && !['/api/onboarding', '/api/onboarding/opening', '/api/state', '/api/chat', '/api/chat/interrupt'].includes(path) && !path.startsWith('/api/checkpoints') && !path.startsWith('/api/memories') && !path.startsWith('/api/life') && !path.startsWith('/api/meeting')) return route.continue();
    const result = await call(directory, path+url.search, req.method(), req.postData() ? req.postDataJSON() : undefined, options);
    if(path==='/api/chat' && (options as {delayedReply?:boolean}).delayedReply)await new Promise(r=>setTimeout(r,1800));
    if (!page.isClosed()) await route.fulfill({status: result.status, headers: result.headers, contentType: result.contentType, body: result.body});
  });
}

let directory='';
test.beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'momo-first-meeting-'));});
test.afterEach(async({page})=>{await page.close();const worker=workers.get(directory);if(worker){const ended=new Promise<void>(r=>worker.child.once('close',()=>r()));worker.child.stdin!.end();await ended;workers.delete(directory);}rmSync(directory,{recursive:true,force:true});});

async function setup(page:Page,options={}){
 await bridge(page,directory,{configured:false,intro:true,...options});await page.goto('/');
 await expect(page.locator('.intro-guide')).toContainText('设置');
 const messages:string[]=[];
 await page.evaluate(()=>{
  const scope=window as unknown as {introObserved:string[]};scope.introObserved=[];
  new MutationObserver(()=>{const text=document.querySelector('.intro-guide')?.textContent;if(text)scope.introObserved.push(text);}).observe(document.body,{subtree:true,childList:true,characterData:true});
 });
 await page.locator('[data-intro=settings]').click();
 await expect(page.locator('.intro-guide')).toContainText('语言');
 messages.push(...await page.evaluate(()=>(window as unknown as {introObserved:string[]}).introObserved));
 expect(messages.every(text=>!text.includes('准备下一步')&&!text.includes('结束初识'))).toBeTruthy();
 expect(await page.locator('.intro-guide').evaluate(el=>getComputedStyle(el).backgroundColor)).toMatch(/rgba\([^)]*, 0\.76\)/);

 await page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true}).click();
 await page.locator('[data-intro=tab-models]').click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','llm');
 const model=page.locator('[data-intro=llm]');
 await model.locator('input').nth(0).fill('https://preview.test');
 await model.locator('input').nth(2).fill('test');
 await model.getByRole('button',{name:'测试',exact:true}).click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','tts');
 if((options as {keepTts?:boolean}).keepTts)return;
 await page.locator('.intro-guide').getByRole('button',{name:'暂时跳过'}).click();
 await expect(page.locator('.intro-guide')).toContainText('返回标题');
 await page.locator('[data-intro=settings-back]').click();
 await expect(page.locator('.intro-guide')).toContainText('启动');
}

test('settings spotlight persists CP1 and naming memory completes only after returning to title',async({page},info)=>{
 await setup(page,{delayedReply:true});await page.reload();
 await expect(page.locator('.intro-guide')).toContainText('启动');
 await page.locator('[data-intro=boot]').click();
 await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
 await expect(page.locator('.intro-guide')).toContainText('称呼');
 for(const viewport of [{width:1280,height:720},{width:800,height:450}]){
  await page.setViewportSize(viewport);
  await expect.poll(async()=>{const guide=await page.locator('.intro-guide').boundingBox(),dialog=await page.locator('.dialog-box').boundingBox();return guide!.y+guide!.height<=dialog!.y-8;}).toBe(true);
 }
 await page.setViewportSize({width:1280,height:720});
 await page.locator('.input-row input').fill('随便聊聊');await page.locator('.input-row input').press('Enter');
 await expect.poll(async()=>JSON.parse((await call(directory,'/api/onboarding')).body).stage).toBe('clarifying');
 await expect(page.locator('.input-row input')).toBeEnabled();
 await page.locator('.input-row input').fill('叫我小星');await page.locator('.input-row input').press('Enter');
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','chat-settings');
 await page.screenshot({path:info.outputPath('intro-name-saved.png')});
 const guideEnd=await page.locator('.intro-guide').boundingBox(),dialogEnd=await page.locator('.dialog-box').boundingBox();
 expect(guideEnd!.y+guideEnd!.height).toBeLessThanOrEqual(dialogEnd!.y-8);
 await page.locator('[data-intro=chat-settings]').click();
 await page.locator('[data-intro=tab-memory]').click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','name-pin');
 await page.locator('[data-intro=name-pin]').click();
 await page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true}).click();
 await page.locator('[data-intro=settings-back]').click();
 await expect(page.locator('.title-screen')).toBeVisible();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','celebration');
 await page.screenshot({path:info.outputPath('intro-celebration.png')});
 await page.locator('.intro-guide').getByRole('button',{name:'开始我们的日常'}).click();
 await expect(page.locator('.intro-guide')).toHaveCount(0);
 await expect.poll(async()=>JSON.parse((await call(directory,'/api/intro')).body).phase).toBe('completed');
 expect(JSON.stringify(JSON.parse((await call(directory,'/api/memories')).body))).toContain('小星');
 await page.locator('[data-intro=boot]').click();
 await expect(page.locator('.intro-guide')).toHaveCount(0);
});

test('language step traps focus, disables off-path interactions and resumes after reload',async({page},info)=>{
 await bridge(page,directory,{configured:false,intro:true});await page.goto('/');
 await expect(page.locator('.intro-guide')).toContainText('设置');
 await page.locator('[data-intro=settings]').click();
 await expect(page.locator('.intro-guide')).toContainText('语言');
 await page.locator('[data-intro=language] button').first().click();
 await page.getByRole('option',{name:'English',exact:true}).click();
 await expect(page.locator('.intro-guide')).toContainText('language');
 for(let i=0;i<8;i++){await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('[data-intro=language],.intro-guide'))).toBeTruthy();}
 await page.screenshot({path:info.outputPath('intro-language.png')});
 await page.locator('.intro-guide').getByRole('button',{name:'Continue',exact:true}).click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','tab-models');
 await page.goto('/');await expect(page.locator('.intro-guide')).toContainText('settings');
 await page.locator('[data-intro=settings]').click();
 await expect(page.locator('.intro-guide')).toContainText('model');
});

test('failed model validation cannot advance or Boot; retry saves the same settings',async({page})=>{
 await bridge(page,directory,{configured:false,intro:true});await page.goto('/');
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','settings');
 const forbidden=await call(directory,'/api/meeting/enter','POST',{clientId:'intro-early-boot'});
 expect(forbidden.status).toBe(409);
 await page.locator('[data-intro=settings]').click();
 await page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true}).click();
 await page.locator('[data-intro=tab-models]').click();await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','llm');
 const model=page.locator('[data-intro=llm]');
 await model.locator('input').nth(0).fill('https://preview.test');await model.locator('input').nth(2).fill('wrong');
 await page.route('**/api/intro/verify',route=>route.fulfill({status:409,json:{detail:'invalid model'}}));
 await model.locator('.probe-btn').click();await expect(page.locator('.intro-guide [role=alert]')).toBeVisible();
 expect(JSON.parse((await call(directory,'/api/intro')).body).phase).toBe('setup');
 await expect(model.locator('input').nth(2)).toHaveValue('wrong');
 await page.unroute('**/api/intro/verify');await bridge(page,directory,{configured:false,intro:true});
 await model.locator('input').nth(2).fill('test');await model.locator('.probe-btn').click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','tts');
});

test('small PC window keeps spotlight and language dropdown inside the stage',async({page},info)=>{
 await page.setViewportSize({width:800,height:450});
 await bridge(page,directory,{configured:false,intro:true});await page.goto('/');
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','settings');
 await page.locator('[data-intro=settings]').click();await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','language');
 await page.locator('[data-intro=language] button').first().click();await page.getByRole('option',{name:'日本語',exact:true}).click();
 await expect(page.locator('.intro-guide')).toContainText('言語');
 await page.locator('.intro-guide button').click();await page.locator('[data-intro=tab-models]').click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','llm');
 await expect.poll(()=>page.locator('.settings-scroll').evaluate(el=>el.scrollLeft)).toBe(0);
 await expect(page.locator('[data-intro=llm] input').first()).toBeInViewport();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-ready','true');
 const ring=await page.locator('.intro-ring').boundingBox(),modelBox=await page.locator('[data-intro=llm]').boundingBox();
 expect(Math.abs(ring!.x-modelBox!.x)).toBeLessThanOrEqual(8);
 const guide=await page.locator('.intro-guide').boundingBox(),stage=await page.locator('.app-stage').boundingBox();
 expect(guide!.x).toBeGreaterThanOrEqual(stage!.x);expect(guide!.y).toBeGreaterThanOrEqual(stage!.y);
 expect(guide!.x+guide!.width).toBeLessThanOrEqual(stage!.x+stage!.width);expect(guide!.y+guide!.height).toBeLessThanOrEqual(stage!.y+stage!.height);
 const url=await page.locator('[data-intro=llm] input').first().boundingBox();
 expect(guide!.x>=url!.x+url!.width||guide!.x+guide!.width<=url!.x||guide!.y>=url!.y+url!.height||guide!.y+guide!.height<=url!.y).toBeTruthy();
 await page.screenshot({path:info.outputPath('intro-small-model.png')});
});


test('refresh after naming resumes memory pinning and celebration requires confirmation',async({page})=>{
 await setup(page);await page.locator('[data-intro=boot]').click();
 await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','name-input');
 await page.locator('.input-row input').fill('叫我小星');await page.locator('.input-row input').press('Enter');
 await expect.poll(async()=>JSON.parse((await call(directory,'/api/intro')).body).phase).toBe('memory');
 await page.reload();await expect(page.locator('.title-screen')).toBeVisible();
 await page.locator('[data-intro=settings]').click();await page.locator('[data-intro=tab-memory]').click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','name-pin');
 await expect(page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true})).toBeDisabled();
 await page.locator('[data-intro=name-pin]').click();
 await page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true}).click();
 await page.locator('[data-intro=settings-back]').click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','celebration');
 await page.reload();await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','celebration');
 await expect(page.locator('.intro-guide')).toContainText('初次相遇');
 await page.locator('.intro-guide').getByRole('button',{name:'开始我们的日常'}).click();
 await expect.poll(async()=>JSON.parse((await call(directory,'/api/intro')).body).phase).toBe('completed');
});

test('optional TTS can be configured and continued, or skipped after failure',async({page})=>{
 await setup(page,{keepTts:true});
 await page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true}).click();
 await expect(page.locator('.intro-guide [role=alert]')).toBeVisible();
 await page.locator('[data-intro=tts] input').first().fill('https://voice.test');
 await page.route('**/api/tts/status',route=>route.fulfill({json:{configured:true,reachable:true,detail:'ready'}}));
 await page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true}).click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','settings-back');
});

test('real configured model completes settings health and durable first-name memory',async({page})=>{
 test.skip(process.env.MOMO_REAL_ONBOARDING_E2E!=='1','opt-in real provider');test.setTimeout(240000);
 await bridge(page,directory,{real:true,intro:true});await page.goto('/');
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','settings');
 await page.locator('[data-intro=settings]').click();await page.locator('.intro-guide button').click();
 await page.locator('[data-intro=tab-models]').click();await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','llm');
 await page.locator('[data-intro=llm] .probe-btn').click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','tts',{timeout:90000});
 await page.locator('.intro-guide').getByRole('button',{name:'暂时跳过'}).click();
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','settings-back');
 await page.locator('[data-intro=settings-back]').click();await page.locator('[data-intro=boot]').click();
 await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
 await page.locator('.input-row input').fill('先聊聊天吧，我还没想好昵称。');await page.locator('.input-row input').press('Enter');
 await expect.poll(async()=>JSON.parse((await call(directory,'/api/onboarding')).body).stage,{timeout:90000}).toBe('clarifying');
 await expect(page.locator('.input-row input')).toBeEnabled({timeout:90000});
 await page.locator('.input-row input').fill('叫我小星就好。');await page.locator('.input-row input').press('Enter');
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-step','chat-settings',{timeout:90000});
 await expect(page.locator('.intro-guide')).toHaveAttribute('data-ready','true',{timeout:90000});
 await page.locator('[data-intro=chat-settings]').click();
 await page.locator('[data-intro=tab-memory]').click();await page.locator('[data-intro=name-pin]').click();
 await page.locator('.intro-guide').getByRole('button',{name:'继续',exact:true}).click();await page.locator('[data-intro=settings-back]').click();
 await page.locator('.intro-guide').getByRole('button',{name:'开始我们的日常'}).click();await expect.poll(async()=>JSON.parse((await call(directory,'/api/intro')).body).phase).toBe('completed');
 expect(JSON.stringify(JSON.parse((await call(directory,'/api/memories')).body))).toContain('小星');
});
