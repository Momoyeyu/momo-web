import {test,expect} from './fixtures';
for(const lang of ['zh','en','ja'])test(`sound preview is available from the sound chapter in ${lang}`,async({page,request},info)=>{
 await page.setViewportSize({width:1280,height:720});
 const state=await(await request.get('/api/state')).json();
 Object.assign(state.settings.general,{lang,sfxVolume:35});
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.goto('/#/settings');
 await page.locator('[data-intro=tab-sound]').click();
 const preview=page.locator('#config-sound');
 await expect(preview.locator('.sel-face')).toHaveCount(2);
 await preview.locator('.sel-face').last().click();
 await preview.getByRole('option').nth(1).click();
 const play=preview.locator('button.config-action');
 await expect(play).toBeEnabled();
 await play.click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(play).toBeFocused();
 await page.screenshot({path:info.outputPath('sound-preview.png')});
});
