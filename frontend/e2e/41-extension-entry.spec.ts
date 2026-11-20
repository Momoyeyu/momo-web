import {test,expect} from './fixtures';
import {openModLibrary} from './mod-fixtures';
import {bootChat,openTab,gotoRoute} from './helpers';

for (const viewport of [{width:1280,height:720},{width:1920,height:1080}]) {
  test('core controls and optional mod entries are reachable at '+viewport.width,async({page})=>{
    await page.setViewportSize(viewport);
    await page.route('**/api/mods',route=>route.fulfill({json:{mods:[]}}));
    await page.route('**/api/mods/official',route=>route.fulfill({json:{mods:[
      {id:'momo.qq',name:'QQ',version:'1.0.0',compatible:true},
      {id:'momo.minecraft',name:'Minecraft',version:'1.0.0',compatible:true},
    ]}}));
    await bootChat(page);
    await openTab(page,'模组');
    const section=page.locator('#config-mods');
    await expect(section.getByRole('button')).toHaveCount(1);
    await expect(section).not.toContainText(/QQ|Minecraft/);
    const library=await openModLibrary(page);
    await expect(library.getByText('还没有安装模组。')).toBeVisible();
    await expect(library.getByRole('button',{name:'安装模组'})).toHaveCount(0);
    await library.getByRole('button',{name:'获取模组'}).click();
    for(const name of ['QQ','Minecraft']){
      const row=library.locator('.opt-row').filter({has:page.getByText(name,{exact:true})});
      await row.getByRole('button',{name:'安装模组'}).click();
      const modal=page.getByRole('dialog',{name,exact:true});
      await expect(modal).toContainText('签名包');
      await modal.getByRole('button',{name:'返回列表'}).click();
    }
    await library.getByRole('button',{name:'返回设置'}).click();
    await openTab(page,'桌面');
    await expect(page.locator('#config-desktop')).toBeInViewport();
    await openTab(page,'浏览器');
    await expect(page.locator('#config-browser')).toBeInViewport();
    await gotoRoute(page,'chat');
    await expect(page.getByRole('button',{name:'拓展',exact:true})).toHaveCount(0);
  });
}
