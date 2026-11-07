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
  let state={mode:'chat' as 'chat'|'pet',clickThrough:false};
  const listeners=new Set<(value:typeof state)=>void>();
  window.momoDesktop={
   getRuntime:async()=>({baseUrl:base,token:'isolated-ui-fixture'}),
   getWindowState:async()=>state,
   dragPetWindow:async phase=>{((window as any).__drag??=[]).push(phase);},
   setPetHitRegions:async regions=>{(window as any).__petRegions=regions;},
   setWindowMode:async mode=>{state={mode,clickThrough:false};listeners.forEach(fn=>fn(state));return state;},
   setPetClickThrough:async value=>{state={...state,clickThrough:value};listeners.forEach(fn=>fn(state));return state;},
   onWindowStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  };
 },{base:baseURL!});
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:true}}}));
 await bootChat(page);
 const before=await page.evaluate(()=>({lease:sessionStorage.getItem('momo.meeting-owner.v1'),canvases:document.querySelectorAll('.live2d-canvas').length}));
 await page.getByRole('button',{name:copy.desktop.enter,exact:true}).click();
 await page.setViewportSize({width:360,height:520});
 await expect(page.locator('html')).toHaveClass(/desktop-pet/);
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
 await page.locator('.chat-page').evaluate(el=>{el.inert=true;});
 await page.getByRole('button',{name:copy.desktop.return,exact:true}).click();
 await page.locator('.chat-page').evaluate(el=>{el.inert=false;});
 await page.setViewportSize({width:1280,height:720});
 await expect(page.locator('html')).not.toHaveClass(/desktop-pet/);
 const after=await page.evaluate(()=>({lease:sessionStorage.getItem('momo.meeting-owner.v1'),canvases:document.querySelectorAll('.live2d-canvas').length}));
 expect(after).toEqual(before);
 await expect(page.locator('.chat-toolbar:not(.desktop-pet-controls)')).toBeVisible();
});
