import {bootChat} from './helpers';
import {test,expect,type Page,type TestInfo} from './fixtures';
import {writeFile} from 'node:fs/promises';

type Frame = {time:number;route:string;startup:boolean;cover:boolean;ink:boolean;drop:boolean;opacity:number;
  animation:string;toolbar:number;interactive:boolean;setup:boolean;burn:string;outgoingBurn:string};
type Audit = {frames:Frame[];done:boolean};

async function fixture(page:Page, configured=true) {
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/api/meeting/'))return route.fulfill(path.endsWith('/leave')?{status:204}:{json:{leaseId:'visual-lease',epoch:1,expiresIn:60}});
    if(!['/api/state','/api/onboarding','/api/life/history','/api/life/live','/api/memories'].includes(path))return route.continue();
    if(route.request().method()!=='GET')return route.fulfill({status:204});
    const json=path==='/api/state'?{settings:{general:{lang:'zh',voiceInput:false},llm:{url:configured?'https://fixture.test':'',model:configured?'fixture':'',key:''}}}
      :path==='/api/onboarding'?{stage:configured?'completed':'new',configured}
      :path==='/api/life/history'?{messages:[],summary:'',hasMore:false,nextBefore:null}:[];
    await route.fulfill({json});
  });
  await page.addInitScript(()=>{
    const scope=window as unknown as {__dialogAudit:Audit;__startDialogAudit:()=>void};
    scope.__startDialogAudit=()=>{
      const audit:Audit={frames:[],done:false};scope.__dialogAudit=audit;
      const start=performance.now();let settled=0;
      const sample=()=>{
        if(scope.__dialogAudit!==audit)return;
        const zone=document.querySelector<HTMLElement>('.page-wrap:last-of-type .dialog-zone')
          ?? document.querySelector<HTMLElement>('.page-wrap.is-chat .dialog-zone');
        const wrap=zone?.closest<HTMLElement>('.page-wrap');
        if(zone&&wrap&&location.hash.endsWith('/chat')){
          const toolbar=wrap.querySelector<HTMLElement>('.chat-toolbar')!;
          const input=zone.querySelector<HTMLInputElement>('input')!;
          const frame:Frame={time:performance.now()-start,route:location.hash,startup:!!document.querySelector('#startup'),
            cover:wrap.classList.contains('is-front'),ink:!!document.querySelector('.chat-entry-canvas'),
            drop:!!document.querySelector('.app-stage.tx-active .tx-drop'),
            opacity:Number(getComputedStyle(zone).opacity),animation:getComputedStyle(zone).animationName,
            toolbar:Number(getComputedStyle(toolbar).opacity),interactive:!input.closest('[inert]'),
            setup:!!document.querySelector('.first-meeting-setup'),burn:getComputedStyle(wrap).animationName,
            outgoingBurn:[...document.querySelectorAll('.page-wrap.is-back')].map(page=>getComputedStyle(page).animationName).join(',')};
          audit.frames.push(frame);
          settled=!frame.startup&&!frame.cover&&!frame.ink&&frame.opacity>.999&&frame.interactive?settled+1:0;
          if(settled>=2){audit.done=true;return;}
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    };
    scope.__startDialogAudit();
  });
}

async function finishAudit(page:Page,info:TestInfo) {
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {__dialogAudit:Audit}).__dialogAudit.done)).toBe(true);
  const frames=await page.evaluate(()=>(window as unknown as {__dialogAudit:Audit}).__dialogAudit.frames);
  const path=info.outputPath(`dialog-frames-${info.attachments.length}.json`);
  await writeFile(path,JSON.stringify(frames,null,2));
  await info.attach('dialog-frames',{path,contentType:'application/json'});
  return frames;
}

function expectSequenced(frames:Frame[]) {
  const covered=frames.filter(frame=>frame.cover||frame.ink||frame.startup);
  expect(covered.length,'must observe the actual covering scene').toBeGreaterThan(0);
  expect(covered.filter(frame=>frame.opacity>.001),'dialog must wait for the covering scene').toEqual([]);
  expect(covered.filter(frame=>frame.interactive||frame.setup),'covered controls and portal must not activate early').toEqual([]);
  const rising=frames.filter(frame=>!frame.startup&&!frame.cover&&!frame.ink&&frame.opacity>.02&&frame.opacity<.95);
  expect(rising.length,'dialog must rise after the scene, rather than finish behind it').toBeGreaterThan(0);
  expect(rising.some(frame=>frame.interactive),'input remains locked until the visible rise completes').toBe(false);
  expect(frames.at(-1)?.interactive).toBe(true);
}

for(const destination of ['设置','记录']){
  test(`dialog resumes with the correct presentation when returning from ${destination}`,async({page},info)=>{
    await fixture(page);
    await bootChat(page);
    await finishAudit(page,info);
    await page.getByRole('button',{name:destination,exact:true}).click();
    await expect(page.locator('.page-wrap')).toHaveCount(1);
    await page.evaluate(()=>(window as unknown as {__startDialogAudit:()=>void}).__startDialogAudit());
    await page.getByRole('button',{name:destination==='设置'?'返回':'返回对话',exact:true}).click();
    const frames=await finishAudit(page,info);
    const covered=frames.filter(frame=>frame.cover);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.every(frame=>frame.burn==='page-chat-burn-in'&&frame.outgoingBurn==='page-burn-away')).toBe(true);
    expect(covered.every(frame=>frame.opacity===1&&frame.toolbar===1)).toBe(true);
    expect(covered.filter(frame=>frame.interactive||frame.setup)).toEqual([]);
    expect(frames.filter(frame=>frame.animation==='dialog-rise'||frame.ink||frame.drop)).toEqual([]);
    expect(frames.at(-1)?.interactive).toBe(true);
  });
}

test('reloading an owned chat waits for startup and restores dialogue in place',async({page},info)=>{
  await fixture(page);
  await bootChat(page);
  await page.reload();
  const frames=await finishAudit(page,info);
  expect(frames.filter(frame=>frame.startup&&frame.interactive)).toEqual([]);
  expect(frames.filter(frame=>frame.ink||frame.animation==='dialog-rise')).toEqual([]);
  expect(frames.at(-1)?.interactive).toBe(true);
});

test('title ASCII finishes before the dialog rises and input unlocks',async({page},info)=>{
  await fixture(page);
  await page.goto('/');
  await page.getByRole('button',{name:'启动 boot'}).click();
  const frames=await finishAudit(page,info);
  expectSequenced(frames);
  expect(frames.some(frame=>frame.ink)).toBe(true);
});

test('first configuration portal waits for the visible dialog, then leaves cleanly',async({page},info)=>{
  await fixture(page,false);
  await page.goto('/');
  await page.getByRole('button',{name:'启动 boot'}).click();
  const frames=await finishAudit(page,info);
  expectSequenced(frames);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.locator('.title-screen')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('reduced motion releases dialogue and input without replaying the rise',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await fixture(page);
  await bootChat(page);
  await expect(page.locator('.input-row input')).toBeEditable();
  expect(await page.locator('.dialog-zone').evaluate(element=>getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'返回',exact:true}).click();
  await expect(page.locator('.input-row input')).toBeEditable();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  expect(await page.locator('.dialog-zone').evaluate(element=>getComputedStyle(element).opacity)).toBe('1');
});

test('cancelling a return transition cannot unlock a later page or duplicate chat',async({page},info)=>{
  await fixture(page);
  await bootChat(page);
  await finishAudit(page,info);
  await page.getByRole('button',{name:'记录',exact:true}).click();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await expect(page.locator('.page-wrap.is-chat.is-front')).toBeAttached();
  await page.evaluate(()=>{location.hash='/settings';});
  await expect(page.locator('.settings-page')).toBeVisible();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(()=>(window as unknown as {__startDialogAudit:()=>void}).__startDialogAudit());
  await page.getByRole('button',{name:'返回',exact:true}).click();
  const frames=await finishAudit(page,info);
  expect(frames.every(frame=>!frame.ink&&frame.animation!=='dialog-rise')).toBe(true);
  await expect(page.locator('.chat-page')).toHaveCount(1);
});

test('the center-out burn reveals dialogue in place and unlocks it on completion',async({page},info)=>{
  await fixture(page);
  await bootChat(page);
  await finishAudit(page,info);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  const style=await page.addStyleTag({content:'.page-wrap.is-chat.is-front, .page-wrap.is-burning-away { animation-play-state: paused !important; }'});
  await page.getByRole('button',{name:'返回',exact:true}).click();
  const incoming=page.locator('.page-wrap.is-chat.is-front');
  const outgoing=page.locator('.page-wrap.is-burning-away');
  await expect(incoming).toHaveCSS('animation-name','page-chat-burn-in');
  await expect(outgoing).toHaveCSS('animation-name','page-burn-away');
  const initial = await incoming.evaluate(element=>getComputedStyle(element).clipPath);
  expect(initial).toMatch(/^polygon\(/);
  await expect(outgoing).toHaveCSS('clip-path', /^polygon\(evenodd,/);
  await expect(incoming.locator('.dialog-zone')).toHaveCSS('opacity','1');
  await expect(incoming.locator('.dialog-zone')).toHaveCSS('animation-name','none');
  await page.evaluate(()=>{
    for (const element of document.querySelectorAll('.page-wrap.is-front, .page-wrap.is-burning-away')) {
      for (const animation of element.getAnimations()) animation.currentTime=180;
    }
  });
  expect(await incoming.evaluate(element=>getComputedStyle(element).clipPath)).not.toBe(initial);
  await page.screenshot({path:info.outputPath('return-with-burn-in-progress.png')});
  await expect(incoming).toHaveAttribute('inert','');
  await style.evaluate(element=>element.remove());
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  await expect(page.locator('.input-row input')).toBeEditable();
});
