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
  for(const select of await page.locator('#config-sound .sel-face').all()){
   expect((await select.boundingBox())!.width).toBeCloseTo(preview!.width,0);
  }
  const rows=page.locator('#config-models .config-model-row');
  await expect(rows.locator('b')).toHaveText(['LLM','TTS']);
  expect(await rows.evaluateAll(nodes=>{
   const boxes=nodes.map(el=>el.getBoundingClientRect());
   return boxes.every((box,i)=>box.x===boxes[0].x && box.width===boxes[0].width && (!i || box.top>=boxes[i-1].bottom-1));
  })).toBe(true);
 }
});
