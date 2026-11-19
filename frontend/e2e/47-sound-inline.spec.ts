import {test,expect} from './fixtures';
for(const lang of ['zh','en','ja'])test(`sound preview is available from the sound chapter in ${lang}`,async({page,request},info)=>{
 await page.setViewportSize({width:1280,height:720});
 const state=await(await request.get('/api/state')).json();
 Object.assign(state.settings.general,{lang,sfxVolume:35});
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.goto('/#/settings');
 await page.locator('[data-intro=tab-sound]').click();
 const trigger=page.locator('#config-sound .config-action');
 await trigger.click();
 const dialog=page.getByRole('dialog');
 await expect(dialog.locator('.sel-face')).toHaveCount(2);
 await dialog.locator('.sel-face').last().click();
 await dialog.getByRole('option').nth(1).click();
 const play=dialog.locator('.modal-foot button');
 await expect(play).toBeEnabled();await play.click();
 await page.screenshot({path:info.outputPath('sound-preview.png')});
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
});
