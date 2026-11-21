import {expect,test} from './fixtures';
import {bootChat,openApp} from './helpers';

test('desktop drag strip stays above the stage across routes and window sizes',async({page,baseURL})=>{
 await page.addInitScript(baseUrl=>{
  window.momoDesktop={
   getRuntime:async()=>({baseUrl,token:'isolated-titlebar'}),
   getWindowState:async()=>({mode:'chat',clickThrough:false}),
   setWindowMode:async mode=>({mode,clickThrough:false}),
   onWindowStateChanged:()=>()=>{},
  };
 },baseURL!);
 await page.setViewportSize({width:1280,height:800});
 await openApp(page);
 const grip=page.locator('.desktop-window-grip');
 const stage=page.locator('.app-stage');
 for(const [width,height] of [[1280,800],[1280,720],[1440,700],[960,540]]){
  await page.setViewportSize({width,height});
  await expect(grip).toBeVisible();
  await expect(grip).toHaveCSS('app-region','drag');
  await expect(grip).toHaveCSS('user-select','none');
  const bar=(await grip.boundingBox())!;
  const picture=(await stage.boundingBox())!;
  expect(bar.y).toBe(0);
  expect(bar.height).toBeGreaterThanOrEqual(28);
  expect(bar.y+bar.height).toBeLessThanOrEqual(picture.y);
  expect(picture.width/picture.height).toBeCloseTo(16/9,2);
  if(width===1280&&height===800)expect(picture.y).toBe(40);
 }
 await bootChat(page);
 await expect(grip).toBeVisible();
 await expect(page.locator('.chat-page .input-row input')).toBeEnabled();
});

test('web keeps the title art unselectable without a desktop drag strip',async({page})=>{
 await openApp(page);
 await expect(page.locator('.desktop-window-grip')).toBeHidden();
 await expect(page.locator('.title-brand')).toHaveCSS('user-select','none');
 await expect(page.locator('img.title-presence')).toHaveAttribute('draggable','false');
});
