import {test,expect} from './fixtures';
import {bootChat} from './helpers';

test('desktop uses the same chat and avatar, restores layout and can return through the host',async({page,baseURL},info)=>{
 await page.setViewportSize({width:1280,height:720});
 await page.addInitScript(({base})=>{
  let state={mode:'chat' as 'chat'|'pet',clickThrough:false};
  const listeners=new Set<(value:typeof state)=>void>();
  window.momoDesktop={
   getRuntime:async()=>({baseUrl:base,token:'isolated-ui-fixture'}),
   getWindowState:async()=>state,
   setWindowMode:async mode=>{state={mode,clickThrough:false};listeners.forEach(fn=>fn(state));return state;},
   setPetClickThrough:async value=>{state={...state,clickThrough:value};listeners.forEach(fn=>fn(state));return state;},
   onWindowStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  };
 },{base:baseURL!});
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:true}}}));
 await bootChat(page);
 const before=await page.evaluate(()=>({lease:sessionStorage.getItem('momo.meeting-owner.v1'),canvases:document.querySelectorAll('.live2d-canvas').length}));
 await page.getByRole('button',{name:'进入桌面',exact:true}).click();
 await page.setViewportSize({width:360,height:520});
 await expect(page.locator('html')).toHaveClass(/desktop-pet/);
 await expect(page.locator('.chat-toolbar')).toBeHidden();
 const bounds=await page.locator('.dialog-box').boundingBox();
 expect(bounds!.width).toBeGreaterThan(300);expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(361);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(521);
 expect(await page.locator('.stage-scene').evaluate(el=>getComputedStyle(el).backgroundImage)).toBe('none');
 await expect(page.locator('.room-background')).toBeHidden();
 await expect(page.getByRole('button',{name:'返回 chat',exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('desktop-pet.png')});
 await page.getByRole('button',{name:'鼠标穿透',exact:true}).click();
 // Native Tray/Dock callback restores the renderer after mouse passthrough.
 await page.evaluate(()=>window.momoDesktop!.setWindowMode!('chat'));
 await page.setViewportSize({width:1280,height:720});
 await expect(page.locator('html')).not.toHaveClass(/desktop-pet/);
 const after=await page.evaluate(()=>({lease:sessionStorage.getItem('momo.meeting-owner.v1'),canvases:document.querySelectorAll('.live2d-canvas').length}));
 expect(after).toEqual(before);
 await expect(page.locator('.chat-toolbar')).toBeVisible();
});
