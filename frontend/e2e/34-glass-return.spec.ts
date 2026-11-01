import {test,expect} from './fixtures';
import {bootChat} from './helpers';
import {writeFile} from 'node:fs/promises';

test.beforeEach(async({page})=>{
 await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await page.route('**/api/meeting**',r=>r.fulfill(r.request().url().endsWith('/leave')?{status:204}:{json:{leaseId:'glass-fixture',epoch:1,expiresIn:3600,activation:'active',focus:false,phonePaused:false,busy:false,activity:null,presentation:null}}));
 await page.route('**/api/phone?**',r=>r.fulfill({json:{apps:[],accountKey:'glass',pending:0,conversations:[],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null}}));
});

test('Home fractures the actual scene, reveals live title and releases all resources',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await bootChat(page);
 await page.locator('.input-row input').fill('玻璃后面是 title');
 await page.screenshot({path:info.outputPath('before-home.png')});
 // Sample prepared texture pixels atomically; the live crack overlay is transparent.
 await page.evaluate(()=>{
  const scope=window as unknown as {glassFrames:{progress:number;png:string;solid:number}[]};scope.glassFrames=[];
  const sample=()=>{
   const c=document.querySelector<HTMLCanvasElement>('.glass-return-canvas');
   if(c?.width&&c.dataset.textured==='true'){const p=Number(c.dataset.progress||0);const next=[.08,.35,.65][scope.glassFrames.length];
    if(next!==undefined&&p>=next){const pixels=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;let solid=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>200)solid++;scope.glassFrames.push({progress:p,png:c.toDataURL(),solid:solid/(c.width*c.height)});}
   }
   if(scope.glassFrames.length<3)requestAnimationFrame(sample);
  };requestAnimationFrame(sample);
 });
 await page.locator('[data-intro=chat-back]').click();
 await expect(page.locator('.glass-return-canvas')).toBeVisible();
 await expect(page.locator('.title-screen')).toBeVisible();
 await expect(page.locator('.app-stage')).toHaveAttribute('inert');
 await expect(page.locator('.chat-page')).toHaveCount(0);
 await expect(page.locator('.chat-entry-canvas,.page-wrap.is-front')).toHaveCount(0);
 await expect(page.locator('.glass-return-canvas')).toHaveCount(0);
 await expect(page.locator('.app-stage')).not.toHaveAttribute('inert');
 const frames=await page.evaluate(()=>(window as unknown as {glassFrames:{progress:number;png:string;solid:number}[]}).glassFrames);
 expect(frames).toHaveLength(3);expect(frames[0].solid).toBeGreaterThan(.8);expect(frames[2].solid).toBeLessThan(frames[0].solid-.2);
 for(let i=0;i<frames.length;i++)await writeFile(info.outputPath(`glass-${i}.png`),Buffer.from(frames[i].png.split(',')[1],'base64'));
 await page.screenshot({path:info.outputPath('after-home.png')});
 await bootChat(page);await page.locator('[data-intro=chat-settings]').click();
 await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
 await page.getByRole('button',{name:'返回对话',exact:true}).click();
 await expect(page.locator('.glass-return-canvas')).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('glass composition holds title behind the falling scene',async({page},info)=>{
 await bootChat(page);await page.clock.install();
 await page.locator('[data-intro=chat-back]').click();
 await expect(page.locator('.glass-return-canvas')).toHaveAttribute('data-textured','true');
 // html-to-image itself uses RAF to finish image decoding; pause only once
 // the capture is complete, then advance the independent fragment timeline.
 await page.clock.pauseAt(await page.evaluate(()=>Date.now())+150);
 await page.clock.runFor(80);await page.screenshot({path:info.outputPath('glass-assembled.png')});
 await page.clock.runFor(270);await page.screenshot({path:info.outputPath('glass-falling.png')});
 await page.clock.runFor(350);await page.screenshot({path:info.outputPath('glass-clearing.png')});
 await page.clock.runFor(1000);await page.clock.resume();
 await expect(page.locator('.glass-return-canvas')).toHaveCount(0);
});

test('crack, separation and fall are observable in order, with preparation behind cracks',async({page},info)=>{
 await bootChat(page);
 await page.evaluate(()=>{
  const scope=window as unknown as {glassPhases:string[];crackedDuringCapture:boolean;splitFrame?:string};scope.glassPhases=[];scope.crackedDuringCapture=false;
  new MutationObserver(()=>{
   const c=document.querySelector<HTMLCanvasElement>('.glass-return-canvas'),phase=c?.dataset.phase;
   if(phase&&scope.glassPhases.at(-1)!==phase)scope.glassPhases.push(phase);
   if(phase==='cracking'&&document.querySelector('.app-stage')?.getAttribute('data-home-phase')==='preparing')scope.crackedDuringCapture=true;
   if(c&&phase==='breaking'&&Number(c.dataset.progress)>.49&&!scope.splitFrame)scope.splitFrame=c.toDataURL();
  }).observe(document.querySelector('.app-stage')!,{subtree:true,attributes:true,childList:true,attributeFilter:['data-phase','data-home-phase']});
 });
 await page.locator('[data-intro=chat-back]').click();
 await expect(page.locator('.glass-return-canvas')).toBeVisible();
 await expect(page.locator('.glass-return-canvas')).toHaveCount(0);
 const observed=await page.evaluate(()=>{const scope=window as unknown as {glassPhases:string[];crackedDuringCapture:boolean;splitFrame?:string};return {glassPhases:scope.glassPhases,crackedDuringCapture:scope.crackedDuringCapture,splitFrame:scope.splitFrame};});
 expect(observed.glassPhases).toEqual(['cracking','breaking','falling']);expect(observed.crackedDuringCapture).toBe(true);
 expect(observed.splitFrame).toBeTruthy();
 await writeFile(info.outputPath('separated-glass.png'),Buffer.from(observed.splitFrame!.split(',')[1],'base64'));
});

test('phone-open Home, resize cancellation and reduced motion cannot trap the title',async({page})=>{
 await bootChat(page);await page.locator('.phone-toggle').click();
 await expect(page.locator('.blur-presence')).toHaveAttribute('data-phase','visible');
 await page.locator('[data-intro=chat-back]').click();await expect(page.locator('.glass-return-canvas')).toBeVisible();
 await page.setViewportSize({width:960,height:800});
 await expect(page.locator('.glass-return-canvas')).toHaveCount(0);await expect(page.locator('.app-stage')).not.toHaveAttribute('inert');
 await bootChat(page);await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('[data-intro=chat-back]').click();await expect(page.locator('.title-screen')).toBeVisible();
 await expect(page.locator('.glass-return-canvas')).toHaveCount(0);await expect(page.locator('.app-stage')).not.toHaveAttribute('inert');
});

test('capture failure and interrupted navigation never replay stale chat pixels',async({page})=>{
 await bootChat(page);
 await page.evaluate(()=>{HTMLCanvasElement.prototype.toDataURL=()=>{throw Error('simulated unreadable WebGL buffer');};});
 await page.locator('[data-intro=chat-back]').click();await expect(page.locator('.title-screen')).toBeVisible();
 await expect(page.locator('.glass-return-canvas')).toHaveCount(0);await expect(page.locator('.app-stage')).not.toHaveAttribute('inert');
 await bootChat(page);
 await page.locator('[data-intro=chat-back]').click();await page.evaluate(()=>{location.hash='#/settings';});
 await expect(page.locator('.settings-page')).toBeVisible();await expect(page.locator('.glass-return-canvas')).toHaveCount(0);
 await expect(page.locator('.app-stage')).not.toHaveAttribute('inert');
});
