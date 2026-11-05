import {test,expect} from './fixtures';
import {bootChat,openExtensionTab,gotoRoute} from './helpers';
test('native observation persists across settings and chat and stops explicitly',async({page})=>{
 let active=false,frames=0,proactive=false,reactions=false;
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:true}}}));
 await page.route('**/api/computer/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/approvals')){await r.fulfill({json:{pending:[],allowlist:[]}});return;}
  if(path.endsWith('/targets')){await r.fulfill({json:{targets:[{windowId:7,ownerPid:9,bundleId:'test.app',name:'Fixture app',path:'/fixture'}]}});return;}
  if(path.endsWith('/settings')){const b=r.request().postDataJSON();proactive=b.proactive;reactions=b.reactions;}
  if(path.endsWith('/start'))active=true;
  if(path.endsWith('/stop'))active=false;
  if(path.endsWith('/frame')){expect(active).toBe(true);frames++;}
  await r.fulfill({json:{active,plugin:'computer',observing:active,generation:23,proactive,reactions}});
 });
 await bootChat(page);await openExtensionTab(page,'插件');
 const open=async()=>{await page.locator('.extension-card').filter({hasText:'桌面陪伴'}).getByRole('button',{name:'配置',exact:true}).click();};
 await open();let modal=page.getByRole('dialog',{name:'桌面陪伴'});
 await modal.getByRole('button',{name:'查找窗口'}).click();await modal.getByRole('combobox').selectOption('7');await modal.getByRole('button',{name:'开启',exact:true}).click();
 await expect.poll(()=>frames).toBeGreaterThan(0);
 await modal.getByRole('switch',{name:'主动发言'}).click();await expect.poll(()=>proactive).toBe(true);
 await modal.getByRole('button',{name:'关闭配置'}).click();await gotoRoute(page,'chat');const before=frames;await expect.poll(()=>frames).toBeGreaterThan(before);
 await openExtensionTab(page,'插件');await open();modal=page.getByRole('dialog',{name:'桌面陪伴'});await modal.getByRole('button',{name:'关闭',exact:true}).click();await expect.poll(()=>active).toBe(false);
});
