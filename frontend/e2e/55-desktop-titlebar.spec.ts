import {expect,test} from './fixtures';
import {bootChat,openApp} from './helpers';

test('desktop matte fills the actual gaps and leaves the 16:9 stage and drag strip intact',async({page,baseURL},info)=>{
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
 const matte=page.locator('.desktop-stage-matte');
 await expect(matte).toBeVisible({timeout:2000});
 await expect(matte).toHaveCSS('pointer-events','none');
 await expect(matte).toHaveAttribute('aria-hidden','true');
 const motif=await matte.getAttribute('data-motif');
 expect(motif).toMatch(/^(pulse|phase|hello)$/);
 for(const [width,height] of [[1280,900],[1280,752],[1440,700],[960,540]]){
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
  const pixelTolerance = .04;
  expect(Math.abs(picture.y - bar.height - (height - picture.y - picture.height))).toBeLessThan(pixelTolerance);
  expect(Math.abs(picture.x - (width - picture.x - picture.width))).toBeLessThan(pixelTolerance);
  await expect(matte).toHaveAttribute('data-motif',motif!);
  const upper=matte.locator('[data-edge=top] img');
  const right=matte.locator('[data-edge=right] .stage-matte-motif');
  if(height===900){
   await expect(upper).toBeVisible();
   await expect(right).toBeHidden();
   await page.screenshot({path:info.outputPath('matte-top-bottom.png')});
  }else if(width===1440){
   await expect(upper).toBeHidden();
   await expect(right).toBeVisible();
   const band=(await matte.locator('[data-edge=right]').boundingBox())!;
   const ornament=(await right.boundingBox())!;
   expect(ornament.x).toBeGreaterThan(band.x);
   expect(ornament.x + ornament.width).toBeLessThan(band.x + band.width);
   expect(ornament.x + ornament.width / 2).toBeCloseTo(band.x + band.width / 2, 1);
   await page.screenshot({path:info.outputPath('matte-left-right.png')});
  }else{
   await expect(upper).toBeHidden();
   await expect(right).toBeHidden();
  }
 }
 await bootChat(page);
 await expect(grip).toBeVisible();
 await expect(matte).toHaveAttribute('data-motif',motif!);
 await expect(page.locator('.chat-page .input-row input')).toBeEnabled();
});

test('web keeps the title art unselectable without a desktop drag strip',async({page})=>{
 await openApp(page);
 await expect(page.locator('.desktop-window-grip')).toBeHidden();
 await expect(page.locator('.desktop-stage-matte')).toHaveCount(0);
 await expect(page.locator('.title-brand')).toHaveCSS('user-select','none');
 await expect(page.locator('img.title-presence')).toHaveAttribute('draggable','false');
});
