import {test,expect} from './fixtures';
import {bootChat} from './helpers';

test('blur and avatar share a 350ms clock in both directions',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await page.route('**/api/meeting**',r=>r.fulfill({json:{leaseId:'blur-fixture',epoch:1,expiresIn:3600,activation:'active',focus:false,phonePaused:false,busy:false,activity:null,presentation:null}}));
 await page.route('**/api/phone?**',r=>r.fulfill({json:{apps:[],accountKey:'blur',pending:0,conversations:[],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null}}));
 await bootChat(page);
 const fx=page.locator('.blur-presence'),content=page.locator('.blur-presence-source'),toggle=page.locator('.phone-toggle');
 for(const opening of [true,false]){
  await toggle.click();
  await page.waitForFunction(()=>{const source=document.querySelector('.blur-presence-source'),avatar=document.querySelector('.live2d-home');return source?.getAnimations().some(a=>a.playState==='running'&&a.startTime!==null)&&avatar?.getAnimations().some(a=>a.playState==='running'&&a.startTime!==null);},{},{polling:'raf'});
  const timing=await page.evaluate(()=>{
   const el=document.querySelector('.blur-presence-source')!,home=document.querySelector('.live2d-home')!;
   const phone=el.getAnimations()[0],avatar=home.getAnimations()[0];
   return {phone:phone.effect!.getTiming(),avatar:avatar.effect!.getTiming(),startDelta:Math.abs(Number(phone.startTime)-Number(avatar.startTime)),opacity:+getComputedStyle(el).opacity,filter:getComputedStyle(el).filter};
  });
  expect(timing.phone.duration).toBe(350);expect(timing.avatar.duration).toBe(350);
  expect(timing.phone.easing).toBe(timing.avatar.easing);expect(timing.startDelta).toBeLessThan(20);
  expect(timing.opacity).toBeGreaterThan(0);expect(timing.opacity).toBeLessThan(1);expect(timing.filter).toContain('blur(');
  // Freeze both CSS clocks at the same sampled point; avoid racing a 350ms window.
  await page.evaluate(()=>{for(const selector of ['.blur-presence-source','.live2d-home'])for(const a of document.querySelector(selector)!.getAnimations()){a.pause();a.currentTime=50;}});
  await page.waitForFunction(()=>{const p=Number(document.querySelector('.blur-presence')?.getAttribute('data-grid-progress'));return p>.3&&p<.6;},{},{polling:'raf'});
  const grid=await page.locator('.phone-grid-defs clipPath').evaluate(el=>({count:el.children.length,top:Number(el.firstElementChild?.getAttribute('width')),bottom:Number(el.lastElementChild?.getAttribute('width'))}));
  expect(grid.count).toBeGreaterThan(100);expect(grid.top).toBe(0);expect(grid.bottom).toBeGreaterThan(0);
  await page.screenshot({path:info.outputPath(opening?'blur-in.png':'blur-out.png')});
  await page.evaluate(()=>{for(const selector of ['.blur-presence-source','.live2d-home'])for(const a of document.querySelector(selector)!.getAnimations())a.play();});
  await expect(fx).toHaveAttribute('data-phase',opening?'visible':'hidden');
  await expect.poll(()=>page.locator('.live2d-home').evaluate(el=>el.getAnimations().filter(a=>a.playState==='running').length)).toBe(0);
 }
 await expect(content).toBeHidden();
 await toggle.click();await expect(fx).toHaveAttribute('data-phase','visible');
 await page.evaluate(()=>{const scope=window as unknown as {blurPhases:string[]};scope.blurPhases=[];new MutationObserver(records=>{for(const r of records)if(r.target instanceof HTMLElement&&r.target.matches('.blur-presence'))scope.blurPhases.push(r.target.dataset.phase??'');}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-phase']});});
 for(const selector of ['[data-intro=chat-settings]','.chat-toolbar button[data-tip=记录]']){
  await page.locator(selector).click();await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await expect(page.locator('.chat-page')).not.toHaveAttribute('inert');await expect(fx).toHaveAttribute('data-phase','visible');
 }
 expect(await page.evaluate(()=>(window as unknown as {blurPhases:string[]}).blurPhases.filter(p=>p==='appearing'||p==='disappearing'))).toEqual([]);
 await toggle.click();await page.waitForTimeout(80);await toggle.click();await expect(fx).toHaveAttribute('data-phase','visible');
 await page.emulateMedia({reducedMotion:'reduce'});await toggle.click();await expect(fx).toHaveAttribute('data-phase','hidden');
 await toggle.click();await expect(fx).toHaveAttribute('data-phase','visible');expect(await content.evaluate(e=>e.getAnimations().length)).toBe(0);
 expect(errors).toEqual([]);
});
