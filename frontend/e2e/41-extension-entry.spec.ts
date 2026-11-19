import {test,expect} from './fixtures';
import {bootChat,openTab,gotoRoute} from './helpers';

for (const viewport of [{width:1280,height:720},{width:1920,height:1080}]) {
  test('core controls and optional mod entries are reachable at '+viewport.width,async({page})=>{
    await page.setViewportSize(viewport);
    await page.route('**/api/mods',route=>route.fulfill({json:{mods:[]}}));
    await bootChat(page);
    await openTab(page,'模组');
    const section=page.locator('#config-mods');
    await expect(section.getByRole('button',{name:'安装模组'})).toHaveCount(2);
    for(const name of ['QQ','Minecraft']){
      const row=section.locator('.opt-row').filter({has:page.getByText(name,{exact:true})});
      await row.getByRole('button',{name:'安装模组'}).click();
      const modal=page.getByRole('dialog',{name,exact:true});
      await expect(modal).toContainText('签名包');
      await modal.getByRole('button',{name:'返回设置'}).click();
    }
    await openTab(page,'桌面');
    await expect(page.locator('#config-desktop')).toBeInViewport();
    await openTab(page,'浏览器');
    await expect(page.locator('#config-browser')).toBeInViewport();
    await gotoRoute(page,'chat');
    await expect(page.getByRole('button',{name:'拓展',exact:true})).toHaveCount(0);
  });
}
