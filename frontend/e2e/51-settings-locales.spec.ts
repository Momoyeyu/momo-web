import {test,expect} from './fixtures';

for (const width of [960,1280]) test('settings action column is stable in three languages at '+width,async({page,request})=>{
  const state=await (await request.get('/api/state')).json();
  await page.setViewportSize({width,height:width*9/16});
  await page.route('**/api/state',route=>route.fulfill({json:state}));
  await page.route('**/api/intro',route=>route.fulfill({json:{phase:'completed',configurationValid:true}}));
  let reference:unknown;
  for(const lang of ['zh','en','ja']){
    state.settings.general.lang=lang;
    await page.goto('/#/settings');await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang',lang==='zh'?'zh-CN':lang);
    await expect(page.locator('.config-index button')).toHaveCount(10);
    await page.evaluate(()=>document.fonts.ready);
    const geometry=await page.locator('.config-card .config-action').evaluateAll(buttons=>buttons.map(el=>{
      const b=el as HTMLElement,r=b.getBoundingClientRect();
      return {width:r.width,height:r.height,right:Math.round(r.right),fits:b.scrollWidth<=b.clientWidth+1&&b.scrollHeight<=b.clientHeight+1};
    }));
    expect(geometry.length).toBeGreaterThanOrEqual(17);
    expect(geometry.every(g=>g.width===112&&g.height===34&&g.fits)).toBe(true);
    expect(new Set(geometry.map(g=>g.right)).size).toBe(1);
    if(reference)expect(geometry).toEqual(reference);
    reference=geometry;
  }
});
