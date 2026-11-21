import {test,expect} from './fixtures';
import {openApp} from './helpers';

test('settings directory selects the last chapter at the scroll limit',async({page})=>{
 for (const [width,height,zoom] of [[1279,799,1],[1280,800,1.25],[960,540,1]]) {
  await page.setViewportSize({width,height});
  await openApp(page,'settings');
  await page.locator('.config-document').evaluate((el,scale)=>{(el as HTMLElement).style.zoom=String(scale);},zoom);
  const scroll=page.locator('.config-scroll');
  const last=page.locator('[aria-controls=config-customize]');
  await scroll.evaluate(el=>{el.scrollTop=0;});
  await expect(page.locator('[aria-controls=config-language]')).toHaveAttribute('aria-current','location');
  await scroll.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await expect(last).toHaveAttribute('aria-current','location');
  await expect(page.locator('#heading-customize')).toBeInViewport();
 }
});

test('sound controls align in three full rows and model details occupy two full rows',async({page})=>{
 await page.route('**/api/intro',route=>route.fulfill({json:{phase:'completed',configurationValid:true}}));
 await openApp(page,'settings');
 for(const [width,height] of [[1280,720],[960,540],[1280,360]]){
  await page.setViewportSize({width,height});
  const sound=page.locator('#config-sound .opt-row');
  await expect(sound).toHaveCount(3);
  const actionEdges=await sound.evaluateAll(rows=>rows.map(row=>[...row.querySelectorAll('.icon-btn')].map(button=>button.getBoundingClientRect().right)));
  expect(actionEdges[0]).toHaveLength(2);
  expect(actionEdges[1]).toEqual(actionEdges[0]);
  expect(actionEdges[2]).toEqual(actionEdges[0]);
  const rows=page.locator('#config-models .config-model-row');
  await expect(rows.locator('b')).toHaveText(['LLM','TTS']);
  expect(await rows.evaluateAll(nodes=>{
   const boxes=nodes.map(el=>el.getBoundingClientRect());
   return boxes.every((box,i)=>box.x===boxes[0].x && box.width===boxes[0].width && (!i || box.top>=boxes[i-1].bottom-1));
  })).toBe(true);
 }
});

test('customize and operations share an inset divider and one card border', async ({page}) => {
 await page.setViewportSize({width:1280,height:720});
 await openApp(page,'settings');
 for (const section of ['customize','operations']) {
  const card = page.locator('#config-'+section+' > .config-card');
  await expect(card).toHaveCSS('border-top-width','1px');
  const split = card.locator('.config-split').first();
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
 const desktop = page.locator('#config-operations .config-split > .opt-row');
 await expect(desktop.first()).toHaveCSS('border-top-width','0px');
 await expect(desktop.last()).toHaveCSS('border-top-width','0px');
 const [left, right] = await Promise.all([desktop.first().boundingBox(),desktop.last().boundingBox()]);
 expect(left!.y).toBeCloseTo(right!.y,0);
 expect(left!.width).toBeCloseTo(right!.width,0);
 await page.setViewportSize({width:640,height:360});
 const [first, second] = await Promise.all([desktop.first().boundingBox(),desktop.last().boundingBox()]);
 expect(first!.x).toBeCloseTo(second!.x,0);
 expect(first!.y + first!.height).toBeLessThanOrEqual(second!.y);
 await expect(desktop.last()).toHaveCSS('border-top-width','1px');
});
