import {test,expect} from './fixtures';
import {openApp} from './helpers';

test('settings directory selects the last chapter at the scroll limit',async({page})=>{
 for (const [width,height,zoom] of [[1279,799,1],[1280,800,1.25],[960,540,1]]) {
  await page.setViewportSize({width,height});
  await openApp(page,'settings');
  await page.locator('.config-document').evaluate((el,scale)=>{(el as HTMLElement).style.zoom=String(scale);},zoom);
  const scroll=page.locator('.config-scroll');
  const last=page.locator('[aria-controls=config-mods]');
  await scroll.evaluate(el=>{el.scrollTop=0;});
  await expect(page.locator('[aria-controls=config-language]')).toHaveAttribute('aria-current','location');
  await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect(last).toHaveAttribute('aria-current','location');
  await expect(page.locator('#heading-mods')).toBeInViewport();
 }
});

test('sound controls remain paired and model details occupy two full rows',async({page})=>{
 await page.route('**/api/intro',route=>route.fulfill({json:{phase:'completed',configurationValid:true}}));
 await openApp(page,'settings');
 for(const [width,height] of [[1280,720],[960,540],[1280,360]]){
  await page.setViewportSize({width,height});
  const pairs=page.locator('#config-sound .sound-pair');
  await expect(pairs).toHaveCount(4);
  for(const pair of await pairs.all()){
   expect(await pair.locator('.opt-row').evaluateAll(nodes=>{
    const [a,b]=nodes.map(el=>el.getBoundingClientRect());
    return a.right<=b.left && Math.abs(a.top-b.top)<1;
   })).toBe(true);
  }
  const preview=await page.locator('#config-sound .config-action').boundingBox();
  expect(preview!.width).toBeLessThanOrEqual(168);
  for(const select of await page.locator('#config-sound .sel-face').all()){
   const box=(await select.boundingBox())!;
   expect(box.width).toBeCloseTo(preview!.width,0);
   expect(box.x).toBeCloseTo(preview!.x,0);
  }
  const rows=page.locator('#config-models .config-model-row');
  await expect(rows.locator('b')).toHaveText(['LLM','TTS']);
  expect(await rows.evaluateAll(nodes=>{
   const boxes=nodes.map(el=>el.getBoundingClientRect());
   return boxes.every((box,i)=>box.x===boxes[0].x && box.width===boxes[0].width && (!i || box.top>=boxes[i-1].bottom-1));
  })).toBe(true);
 }
});

test('sound and desktop share an inset divider and one card border', async ({page}) => {
 await page.setViewportSize({width:1280,height:720});
 await openApp(page,'settings');
 for (const section of ['sound','desktop']) {
  const card = page.locator('#config-'+section+' > .config-card');
  await expect(card).toHaveCSS('border-top-width','1px');
  const split = card.locator('.config-split');
  await expect(split).toHaveCount(1, {timeout:2000});
  const line = await split.evaluate(el => {
   const style = getComputedStyle(el,'::before');
   return {content:style.content, width:style.width, start:style.insetInlineStart,
    center:el.clientWidth / 2, pointerEvents:style.pointerEvents};
  });
  expect(line.content).toBe('""');
  expect(line.width).toBe('1px');
  expect(parseFloat(line.start)).toBeCloseTo(line.center,0);
  expect(line.pointerEvents).toBe('none');
 }
 const desktop = page.locator('#config-desktop .desktop-config-group');
 await expect(desktop.first()).toHaveCSS('border-top-width','0px');
 await expect(desktop.last()).toHaveCSS('border-top-width','0px');
 const [left, right] = await Promise.all([desktop.first().boundingBox(),desktop.last().boundingBox()]);
 expect(left!.y).toBeCloseTo(right!.y,0);
 expect(left!.width).toBeCloseTo(right!.width,0);
 const soundRows = page.locator('#config-sound .sound-pair');
 await expect(soundRows.nth(1)).toHaveCSS('border-top-width','0px');
 for (const row of await soundRows.nth(1).locator('.opt-row').all()) {
  await expect(row).toHaveCSS('border-top-width','1px');
 }
 await page.setViewportSize({width:640,height:360});
 const [first, second] = await Promise.all([desktop.first().boundingBox(),desktop.last().boundingBox()]);
 expect(first!.x).toBeCloseTo(second!.x,0);
 expect(first!.y + first!.height).toBeLessThanOrEqual(second!.y);
 await expect(desktop.last()).toHaveCSS('border-top-width','1px');
});
