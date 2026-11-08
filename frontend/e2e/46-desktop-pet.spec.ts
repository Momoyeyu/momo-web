import {test,expect} from './fixtures';
import {bootChat,readState,writeState} from './helpers';
import {zh} from '../src/i18n/zh';
import {en} from '../src/i18n/en';
import {ja} from '../src/i18n/ja';

for(const lang of ['zh','en','ja'] as const)test(`desktop framing, folding, hit regions and escape controls (${lang})`,async({page,baseURL,request},info)=>{
 const copy={zh,en,ja}[lang];
 const saved=await readState(request);(saved as any).settings.general.lang=lang;await writeState(request,saved);
 await page.setViewportSize({width:1280,height:720});
 await page.addInitScript(({base})=>{
  let state:{mode:'chat'|'pet';clickThrough:boolean;panel?:{width:number;petWidth:number}}={mode:'chat',clickThrough:false};
  const listeners=new Set<(value:typeof state)=>void>();
  window.momoDesktop={
   getRuntime:async()=>({baseUrl:base,token:'isolated-ui-fixture'}),
   getWindowState:async()=>state,
   setPetPanel:async open=>{state={...state,panel:open?{width:292,petWidth:320}:undefined};listeners.forEach(fn=>fn(state));return state;},
   dragPetWindow:async phase=>{((window as any).__drag??=[]).push(phase);},
   setPetHitRegions:async regions=>{(window as any).__petRegions=regions;},
   setWindowMode:async mode=>{state={mode,clickThrough:false};listeners.forEach(fn=>fn(state));return state;},
   setPetClickThrough:async value=>{state={...state,clickThrough:value};listeners.forEach(fn=>fn(state));return state;},
   onWindowStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  };
 },{base:baseURL!});
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:true}}}));
 let observing=false,allowed=true,desktopError='',reacting=false;let requests=0,frames=0;
 const computerStatus=()=>({observing:false,desktopAllowed:allowed,desktopError,proactive:reacting,reactions:reacting});
 await page.route('**/api/computer/settings',r=>{const data=r.request().postDataJSON();expect(data.proactive).toBe(data.reactions);reacting=data.proactive;return r.fulfill({json:computerStatus()});});
 await page.route('**/api/computer/desktop/frame',r=>{frames++;return r.fulfill({json:computerStatus()});});
 const target={windowId:42,ownerPid:123,bundleId:'test.editor',path:'/test',name:'Test Editor',title:'Smoke document'};
 await page.route('**/api/computer/native/status',r=>r.fulfill({json:{active:observing,plugin:'computer',target:observing?target:null}}));
 await page.route('**/api/computer/native/targets',r=>r.fulfill({json:{targets:Array.from({length:24},(_,i)=>({...target,windowId:42+i,title:`Smoke document ${i}`})),screenPermission:true,inputPermission:true}}));
 await page.route('**/api/computer/native/start',r=>{expect(r.request().postDataJSON().permissions).toEqual(['observe','interact']);requests++;observing=true;return r.fulfill({json:{active:true}});});
 await page.route('**/api/computer/native/stop',r=>{observing=false;return r.fulfill({json:{active:false}});});
 await page.route('**/api/computer/native/frame',r=>r.fulfill({json:{}}));
 await page.route('**/api/computer/status',r=>r.fulfill({json:computerStatus()}));
 await page.route('**/api/computer/desktop/observation',r=>{allowed=r.request().postDataJSON().enabled;return r.fulfill({json:computerStatus()});});
 await bootChat(page);
 await expect(page.getByRole('button',{name:copy.settings.tabs.extend,exact:true})).toHaveCount(0);
 const proactive=page.getByRole('button',{name:copy.desktop.react,exact:true});
 await expect(proactive).toHaveAttribute('aria-pressed','false');
 const tts=page.locator('.chat-toolbar button').filter({has:page.locator('svg path[d="M4.6 9.8h2.9L11.4 6.6v10.8L7.5 14.2H4.6z"]')});
 const ttsLabel=await tts.getAttribute('aria-label');
 expect(await proactive.locator('svg').innerHTML()).not.toBe(await tts.locator('svg').innerHTML());
 const inactiveColor=await proactive.evaluate(el=>getComputedStyle(el).color);
 await proactive.click();await expect(proactive).toHaveAttribute('aria-pressed','true');
 await expect.poll(()=>proactive.evaluate(el=>getComputedStyle(el).color)).not.toBe(inactiveColor);
 await expect.poll(()=>frames).toBeGreaterThan(0);
 await expect(tts).toHaveAttribute('aria-label',ttsLabel!);
 await page.mouse.move(1,1);await page.screenshot({path:info.outputPath('chat-proactive.png')});
 const before=await page.evaluate(()=>({lease:sessionStorage.getItem('momo.meeting-owner.v1'),canvases:document.querySelectorAll('.live2d-canvas').length}));
 await page.getByRole('button',{name:copy.desktop.enter,exact:true}).click();
 await page.setViewportSize({width:360,height:520});
 await expect(page.locator('html')).toHaveClass(/desktop-pet/);
 await expect(proactive).toHaveAttribute('aria-pressed','true');
 await proactive.click();await expect(proactive).toHaveAttribute('aria-pressed','false');
 const stoppedFrames=frames;await page.waitForTimeout(2800);expect(frames).toBe(stoppedFrames);
 await expect(page.locator('.chat-toolbar:not(.desktop-pet-controls)')).toBeHidden();
 await expect(page.locator('.dialog-box')).toBeHidden();
 await page.screenshot({path:info.outputPath('pet-collapsed-full.png')});
 const dragBox=await page.locator('.desktop-pet-drag').boundingBox();
 await page.mouse.move(dragBox!.x+40,dragBox!.y+80);await page.mouse.down();
 await page.mouse.move(dragBox!.x+70,dragBox!.y+100,{steps:4});await page.mouse.up();
 expect(await page.evaluate(()=>(window as any).__drag)).toEqual(expect.arrayContaining(['start','move','end']));
 await page.getByRole('button',{name:copy.desktop.expandDialog,exact:true}).click();
 await expect(page.locator('.dialog-box')).toBeVisible();
 await page.locator('.dialog-drawer').evaluate(async el=>{await Promise.allSettled(el.getAnimations().map(a=>a.finished));});
 const bounds=await page.locator('.dialog-box').boundingBox();
 expect(bounds!.width).toBeGreaterThan(300);expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(361);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(521);
 expect(await page.locator('.stage-scene').evaluate(el=>getComputedStyle(el).backgroundImage)).toBe('none');
 await expect(page.locator('.room-background')).toBeHidden();
 await expect(page.getByRole('button',{name:copy.desktop.return,exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('desktop-pet.png')});
 await page.getByRole('button',{name:copy.desktop.clickThrough,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).__petRegions?.length??0)).toBeGreaterThan(1);
 await page.getByRole('button',{name:copy.desktop.collapseDialog,exact:true}).click();
 await expect(page.locator('.dialog-box')).toBeHidden();
 await expect.poll(()=>page.evaluate(()=>(window as any).__petRegions?.length??0)).toBe(1);
 await page.getByRole('button',{name:copy.desktop.clickThrough,exact:true}).click();
 await page.getByRole('button',{name:copy.desktop.halfBody,exact:true}).click();
 await page.screenshot({path:info.outputPath('pet-collapsed-half.png')});
 await page.locator('.desktop-pet-controls').getByRole('button',{name:copy.performance.fullBody,exact:true}).click();
 for(const size of [{width:360,height:520},{width:320,height:440}]){
  await page.setViewportSize(size);
  await page.getByRole('button',{name:copy.desktop.expandDialog,exact:true}).click();
  await expect(page.locator('.dialog-box')).toBeVisible();
 await page.locator('.dialog-drawer').evaluate(async el=>{await Promise.allSettled(el.getAnimations().map(a=>a.finished));});
  const rail=await page.locator('.desktop-pet-controls').boundingBox(),panel=await page.locator('.dialog-box').boundingBox();
  expect(rail!.y+rail!.height).toBeLessThan(panel!.y);
  for(const button of await page.locator('.desktop-pet-controls .tb').all()){
   const box=await button.boundingBox(),icon=await button.locator('svg').boundingBox();
   expect(Math.abs(box!.x+box!.width/2-icon!.x-icon!.width/2)).toBeLessThan(1);
   expect(Math.abs(box!.y+box!.height/2-icon!.y-icon!.height/2)).toBeLessThan(1);
  }
  await page.screenshot({path:info.outputPath(`pet-expanded-${size.width}.png`)});
  await page.getByRole('button',{name:copy.desktop.collapseDialog,exact:true}).click();
 }
 // Looking is a direct capability toggle, not an application authorization form.
 const sight=page.getByRole('button',{name:copy.desktop.observe,exact:true});
 await expect(sight).toHaveAttribute('data-observation-state','on');
 const onShape=await sight.locator('svg').innerHTML();
 await page.mouse.move(1,1);await sight.screenshot({path:info.outputPath('observation-on.png')});
 await page.getByRole('button',{name:copy.desktop.observe,exact:true}).click();
 expect(allowed).toBe(false);expect(requests).toBe(0);
 await expect(sight).toHaveAttribute('data-observation-state','off');
 expect(await sight.locator('svg').innerHTML()).not.toBe(onShape);
 await page.mouse.move(1,1);await sight.screenshot({path:info.outputPath('observation-off.png')});
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:copy.desktop.observe,exact:true}).click();
 expect(allowed).toBe(true);expect(requests).toBe(0);
 desktopError='screen-permission';
 await expect(sight).toHaveAttribute('data-observation-state','error');
 expect(await sight.locator('svg').innerHTML()).not.toBe(onShape);
 await sight.screenshot({path:info.outputPath('observation-error.png')});
 desktopError='';await expect(sight).toHaveAttribute('data-observation-state','on');
 await page.getByRole('button',{name:copy.desktop.operate,exact:true}).click();
 await page.setViewportSize({width:612,height:440});
 const observer=page.getByRole('dialog',{name:copy.desktop.operate,exact:true});
 await expect(observer).toBeVisible();
 await expect(observer.getByRole('listitem')).toHaveCount(24);
 const modalBounds=await observer.boundingBox(),stageBounds=await page.locator('.app-stage').boundingBox();
 expect(modalBounds!.x+modalBounds!.width).toBeLessThan(stageBounds!.x);
 expect(modalBounds!.y+modalBounds!.height).toBeLessThanOrEqual(440);
 const last=observer.getByRole('listitem').last();await last.scrollIntoViewIfNeeded();await last.click();
 expect(await observer.locator('.pet-target-list').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 await observer.getByRole('button',{name:copy.desktop.operate,exact:true}).last().click();
 await expect(observer.getByText('Smoke document',{exact:true})).toBeVisible();expect(requests).toBe(1);
 await page.screenshot({path:info.outputPath('pet-control-beside-320.png')});
 await observer.getByRole('button',{name:copy.browser.stop,exact:true}).click();
 await observer.getByRole('button',{name:copy.browser.title,exact:true}).click();
 await expect(observer.locator('.pet-target-list')).toBeVisible();
 await observer.getByRole('button',{name:copy.minecraft.title,exact:true}).click();
 await observer.locator('.pet-utility-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});
 await page.screenshot({path:info.outputPath('pet-game-scroll-320.png')});
 await observer.getByRole('button',{name:copy.browser.dismiss,exact:true}).click();
 await page.setViewportSize({width:320,height:440});
 await page.locator('.chat-page').evaluate(el=>{el.inert=true;});
 await page.getByRole('button',{name:copy.desktop.return,exact:true}).click();
 await page.locator('.chat-page').evaluate(el=>{el.inert=false;});
 await page.setViewportSize({width:1280,height:720});
 await expect(page.locator('html')).not.toHaveClass(/desktop-pet/);
 const after=await page.evaluate(()=>({lease:sessionStorage.getItem('momo.meeting-owner.v1'),canvases:document.querySelectorAll('.live2d-canvas').length}));
 expect(after).toEqual(before);
 await expect(page.locator('.chat-toolbar:not(.desktop-pet-controls)')).toBeVisible();
 await expect(proactive).toHaveAttribute('aria-pressed','false');
 await expect(tts).toHaveAttribute('aria-label',ttsLabel!);
 // Explicit switches survive leaving pet mode and a full renderer restart.
 await page.getByRole('button',{name:copy.desktop.enter,exact:true}).click();
 await page.setViewportSize({width:360,height:520});
 await page.getByRole('button',{name:copy.desktop.halfBody,exact:true}).click();
 await page.getByRole('button',{name:copy.desktop.expandDialog,exact:true}).click();
 await page.getByRole('button',{name:copy.desktop.clickThrough,exact:true}).click();
 await page.getByRole('button',{name:copy.desktop.return,exact:true}).click();
 await page.reload();await page.setViewportSize({width:1280,height:720});
 await bootChat(page);
 await page.getByRole('button',{name:copy.desktop.enter,exact:true}).click();
 await page.setViewportSize({width:360,height:520});
 await expect(page.locator('.desktop-pet-controls').getByRole('button',{name:copy.performance.fullBody,exact:true})).toBeVisible();
 await expect(page.locator('.dialog-box')).toBeVisible();
 await expect(page.getByRole('button',{name:copy.desktop.clickThrough,exact:true})).toHaveAttribute('aria-pressed','true');
 await expect.poll(()=>page.evaluate(()=>(window as any).__petRegions?.length??0)).toBeGreaterThan(1);
 await page.mouse.move(1,1);await page.screenshot({path:info.outputPath('pet-restored.png')});
 // Keep language cases independent even though the test API owns one state file.
 await page.evaluate(async()=>{const store=await import('/src/lib/store.ts');store.updateGeneral({petCloseUp:false,petDialogCollapsed:true,petClickThrough:false});await store.flushPendingState();});
});
