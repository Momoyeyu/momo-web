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

test('sound and models use two aligned groups on wide stages and one column on narrow stages',async({page})=>{
 await page.setViewportSize({width:1280,height:720});
 await page.route('**/api/intro',route=>route.fulfill({json:{phase:'completed',configurationValid:true}}));
 await openApp(page,'settings');
 for(const [width,height,wide] of [[1280,720,true],[960,540,false],[1280,360,false]] as const){
  await page.setViewportSize({width,height});
  for(const section of ['sound','models']){
   const groups=page.locator('#config-'+section+' .config-columns > .config-group');
   await expect(groups).toHaveCount(2);
   await expect.poll(()=>groups.evaluateAll(nodes=>{
    const [a,b]=nodes.map(el=>el.getBoundingClientRect());
    return a.right<=b.left && Math.abs(a.top-b.top)<1;
   })).toBe(wide);
   if(!wide){
    const [a,b]=(await groups.evaluateAll(nodes=>nodes.map(el=>{
     const r=el.getBoundingClientRect();
     return {x:r.left,top:r.top,bottom:r.bottom};
    })));
    expect(a.x).toBe(b.x);
    expect(a.bottom).toBeLessThanOrEqual(b.top);
   }
  }
 }
});
