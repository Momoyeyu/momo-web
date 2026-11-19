import {test,expect} from './fixtures';
import {bootChat,readState,writeState} from './helpers';
import {zh} from '../src/i18n/zh';
import {en} from '../src/i18n/en';
import {ja} from '../src/i18n/ja';

test('game control brings the same meeting into desktop pet once per connection',async({page,baseURL,request})=>{
 const saved=await readState(request);
 Object.assign((saved as any).settings.general,{lang:'zh',minecraftPlay:false,petDialogCollapsed:true});
 await writeState(request,saved);
 await page.addInitScript(base=>{
  let state:{mode:'chat'|'pet';clickThrough:boolean}={mode:'chat',clickThrough:false};
  const listeners=new Set<(value:typeof state)=>void>();
  window.momoDesktop={
   getRuntime:async()=>({baseUrl:base,token:'isolated-game-pet'}),getWindowState:async()=>state,
   setGameOverlay:async enabled=>{document.documentElement.dataset.gameOverlay=String(enabled);},
   setWindowMode:async mode=>{state={mode,clickThrough:false};listeners.forEach(fn=>fn(state));return state;},
   setPetClickThrough:async clickThrough=>{state={...state,clickThrough};return state;},
   onWindowStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  };
 },baseURL!);
 const session={id:'game-one',pid:8123,world:'local:test',account:'test',playerName:'Player',worldName:'Fixture',ready:true};
 let permissions:string[]=[],generation=0,paused=false;
 const status=()=>({active:!!permissions.length,sessionId:permissions.length?session.id:null,generation,permissions,paused,autonomous:false,decisionNeeded:false,tasks:[],goal:null});
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:false,browser:false,minecraft:true}}}));
 await page.route('**/api/minecraft/sessions',r=>r.fulfill({json:{sessions:[session]}}));
 await page.route('**/api/minecraft/status',r=>r.fulfill({json:status()}));
 await page.route('**/api/minecraft/attach',r=>{permissions=r.request().postDataJSON().permissions;generation++;paused=false;return r.fulfill({json:status()});});
 await page.route('**/api/minecraft/tasks',r=>{paused=r.request().postDataJSON().action==='pause';return r.fulfill({json:status()});});
 await page.route('**/api/minecraft/stop',r=>{permissions=[];return r.fulfill({json:status()});});
 await bootChat(page);
 const lease=()=>page.evaluate(()=>sessionStorage.getItem('momo.meeting-owner.v1'));
 const owner=await lease();
 const chatGame=page.locator('.chat-toolbar:not(.desktop-pet-controls)').getByRole('button',{name:zh.minecraft.title,exact:true});
 const panel=page.locator('#chat-game-activity');
 const start=async()=>{
  await panel.locator('.sel-face').click();
  await panel.getByRole('option',{name:'Player · Fixture'}).click();
  await panel.getByRole('button',{name:zh.minecraft.start,exact:true}).click();
 };
 await chatGame.click();await start();
 await expect(panel.getByText(zh.minecraft.running,{exact:true})).toBeVisible();
 await expect(page.locator('html')).not.toHaveClass(/desktop-pet/);
 await panel.getByRole('button',{name:zh.minecraft.stop,exact:true}).click();
 await panel.getByRole('switch',{name:zh.minecraft.play,exact:true}).click();
 await start();
 await expect(page.locator('html')).toHaveClass(/desktop-pet/);
 expect(await lease()).toBe(owner);
 await expect(page.locator('html')).toHaveAttribute('data-game-overlay','true');
 await expect(page.locator('.dialog-box')).toBeHidden();
 const petGame=page.locator('.desktop-pet-controls').getByRole('button',{name:zh.minecraft.title,exact:true});
 await petGame.click();
 const petPanel=page.locator('.pet-utility');
 await petPanel.getByRole('button',{name:zh.minecraft.pausePlay,exact:true}).click();
 await expect(petPanel.getByRole('button',{name:zh.minecraft.resumePlay,exact:true})).toBeVisible();
 await page.getByRole('button',{name:zh.desktop.return,exact:true}).click();
 await chatGame.click();
 await expect(panel.getByRole('button',{name:zh.minecraft.resumePlay,exact:true})).toBeVisible();
 await panel.getByRole('button',{name:zh.minecraft.resumePlay,exact:true}).click();
 await expect(panel.getByRole('button',{name:zh.minecraft.pausePlay,exact:true})).toBeVisible();
 await expect(page.locator('html')).not.toHaveClass(/desktop-pet/);
 await panel.getByRole('button',{name:zh.minecraft.stop,exact:true}).click();
 await start();
 await expect(page.locator('html')).toHaveClass(/desktop-pet/);
 expect(await lease()).toBe(owner);
});

for(const lang of ['zh','en','ja'] as const)test(`desktop framing, folding, hit regions and escape controls (${lang})`,async({page,baseURL,request},info)=>{
 const copy={zh,en,ja}[lang];
 const saved=await readState(request);
 Object.assign((saved as any).settings.general,{lang,petDialogCollapsed:true,petCloseUp:false,petClickThrough:false,chatCloseUp:true});
 await writeState(request,saved);
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
 const computerStatus=()=>({observing:false,desktopAllowed:allowed,desktopAccessGranted:true,desktopError,proactive:reacting,reactions:reacting});
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

test('pet mode and its return control work with desktop access declined',async({page,baseURL,request})=>{
 const saved=await readState(request);
 Object.assign((saved as any).settings.general,{lang:'zh',petClickThrough:false});
 await writeState(request,saved);
 await page.addInitScript(base=>{
   let state:{mode:'chat'|'pet';clickThrough:boolean}={mode:'chat',clickThrough:false};
   const listeners=new Set<(s:typeof state)=>void>();
   window.momoDesktop={
     getRuntime:async()=>({baseUrl:base,token:'isolated-pet-test'}),
     getWindowState:async()=>state,
     setWindowMode:async mode=>{state={mode,clickThrough:false};listeners.forEach(fn=>fn(state));return state;},
     onWindowStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
   };
 },baseURL!);
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:false,browser:false,minecraft:false},supported:{computer:true,browser:true,minecraft:false}}}));
 await page.route('**/api/computer/access',r=>r.fulfill({json:{available:true,granted:false,blocked:[]}}));
 await page.route('**/api/computer/status',r=>r.fulfill({json:{desktopAllowed:true,desktopAccessGranted:false,proactive:true,reactions:true}}));
 const frames:string[]=[];page.on('request',r=>{if(r.url().includes('/api/computer/desktop/frame'))frames.push(r.url());});
 await bootChat(page);
 await page.getByRole('button',{name:zh.desktop.enter,exact:true}).click();
 await expect(page.locator('html')).toHaveClass(/desktop-pet/);
 const rail=page.locator('.desktop-pet-controls');
 await expect(rail.getByRole('button',{name:zh.desktop.observe})).toHaveAttribute('aria-pressed','false');
 await rail.getByRole('button',{name:zh.desktop.return,exact:true}).click();
 await expect(page.locator('html')).not.toHaveClass(/desktop-pet/);
 expect(frames).toEqual([]);
});
