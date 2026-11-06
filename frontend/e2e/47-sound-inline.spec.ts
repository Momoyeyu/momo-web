import {test,expect} from './fixtures';
for(const lang of ['zh','en','ja'])test(`sound preview shares the style row ${lang}`,async({page,request},info)=>{
 await page.setViewportSize({width:1280,height:720});
 const state=await(await request.get('/api/state')).json();state.settings.general.lang=lang;
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.goto('/#/settings');
 const name={zh:'试听音效',en:'Preview sound',ja:'効果音を試聴'}[lang]!;
 const row=page.locator('.opt-row').filter({has:page.getByRole('button',{name,exact:true})});
 await expect(row).toHaveCount(1);
 const select=await row.locator('.sel-face').boundingBox();const preview=await row.getByRole('button',{name,exact:true}).boundingBox();
 expect(Math.abs(select!.y+select!.height/2-preview!.y-preview!.height/2)).toBeLessThan(2);
 expect(preview!.x).toBeGreaterThan(select!.x+select!.width);
 await page.screenshot({path:info.outputPath('sound-settings.png')});
});
