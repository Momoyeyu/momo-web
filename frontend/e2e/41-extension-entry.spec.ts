import {test,expect} from './fixtures';
import {bootChat,openExtensionTab,gotoRoute} from './helpers';
for(const viewport of [{width:1280,height:720},{width:1920,height:1080}])test(`extensions fit and Chat avoids duplicate plugin menus ${viewport.width}`,async({page},info)=>{
 await page.setViewportSize(viewport);
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:true}}}));
 await bootChat(page);await openExtensionTab(page,'插件');await page.waitForTimeout(450);
 await expect(page.locator('.extension-card')).toHaveCount(3);
 const pager=page.locator('.plugin-library .list-pager');
 await expect(pager).toBeVisible();
 const rect=await pager.boundingBox();expect(rect!.y+rect!.height).toBeLessThan(viewport.height);
 await page.screenshot({path:info.outputPath('plugin-cards.png')});
 await gotoRoute(page,'chat');
 await expect(page.getByRole('button',{name:'拓展',exact:true})).toHaveCount(0);
 await page.screenshot({path:info.outputPath('chat-scene-controls.png')});
});
