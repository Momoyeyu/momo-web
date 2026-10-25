import {test,expect,type Page,type TestInfo} from './fixtures';
import {writeFile} from 'node:fs/promises';

type Frame = {time:number;route:string;startup:boolean;cover:boolean;ink:boolean;opacity:number;
  animation:string;toolbar:number;interactive:boolean;setup:boolean};
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
            opacity:Number(getComputedStyle(zone).opacity),animation:getComputedStyle(zone).animationName,
            toolbar:Number(getComputedStyle(toolbar).opacity),interactive:!input.closest('[inert]'),
            setup:!!document.querySelector('.first-meeting-setup')};
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
  test(`dialog waits for the scene when returning from ${destination}`,async({page},info)=>{
    await fixture(page);
    await page.goto('/#/chat');
    await finishAudit(page,info);
    await page.getByRole('button',{name:destination,exact:true}).click();
    await expect(page.locator('.page-wrap')).toHaveCount(1);
    await page.evaluate(()=>(window as unknown as {__startDialogAudit:()=>void}).__startDialogAudit());
    await page.getByRole('button',{name:'返回对话',exact:true}).click();
    const frames=await finishAudit(page,info);
    expectSequenced(frames);
    expect(frames.some(frame=>frame.ink)).toBe(false);
  });
}

test('direct chat waits for startup before its dialog rises',async({page},info)=>{
  await fixture(page);
  await page.goto('/#/chat');
  expectSequenced(await finishAudit(page,info));
});

test('title ASCII finishes before the dialog rises and input unlocks',async({page},info)=>{
  await fixture(page);
  await page.goto('/');
  await page.getByRole('button',{name:'见面 meet'}).click();
  const frames=await finishAudit(page,info);
  expectSequenced(frames);
  expect(frames.some(frame=>frame.ink)).toBe(true);
});

test('first configuration portal waits for the visible dialog, then leaves cleanly',async({page},info)=>{
  await fixture(page,false);
  await page.goto('/');
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
  await page.goto('/#/chat');
  await expect(page.locator('.input-row input')).toBeEditable();
  expect(await page.locator('.dialog-zone').evaluate(element=>getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await expect(page.locator('.input-row input')).toBeEditable();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  expect(await page.locator('.dialog-zone').evaluate(element=>getComputedStyle(element).opacity)).toBe('1');
});

test('cancelling during the rise cannot unlock a later page or duplicate chat',async({page},info)=>{
  await fixture(page);
  await page.goto('/#/chat');
  await finishAudit(page,info);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await page.waitForFunction(()=>{
    const zone=document.querySelector('.dialog-zone');
    return zone && !zone.closest('.is-front') && Number(getComputedStyle(zone).opacity)>.05 && Number(getComputedStyle(zone).opacity)<.9;
  });
  await page.evaluate(()=>{location.hash='/backlog';});
  await expect(page.locator('.backlog-page')).toBeVisible();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(()=>(window as unknown as {__startDialogAudit:()=>void}).__startDialogAudit());
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  expectSequenced(await finishAudit(page,info));
  await expect(page.locator('.chat-page')).toHaveCount(1);
});

test('input follows a paused or cancelled visual animation instead of a timer',async({page},info)=>{
  await fixture(page);
  await page.goto('/#/chat');
  await finishAudit(page,info);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.locator('.page-wrap')).toHaveCount(1);
  const style=await page.addStyleTag({content:'.dialog-zone { animation-play-state: paused !important; }'});
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
  await page.waitForTimeout(550); // Longer than the normal rise; the visual clock is deliberately paused.
  expect(await page.locator('.input-row input').evaluate(element=>!!element.closest('[inert]'))).toBe(true);
  await style.evaluate(element=>element.remove());
  await page.emulateMedia({reducedMotion:'reduce'}); // Cancels the CSS rise; readiness must still resolve.
  await expect.poll(()=>page.locator('.input-row input').evaluate(element=>!!element.closest('[inert]'))).toBe(false);
  expect(await page.locator('.dialog-zone').evaluate(element=>getComputedStyle(element).opacity)).toBe('1');
});
