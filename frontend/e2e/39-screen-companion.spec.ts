import {test,expect} from './fixtures';
import {bootChat,openTab} from './helpers';

test('native desktop start, companionship preferences and confirmed stop remain available from settings',async({page})=>{
 let active=false,proactive=false,reactions=false;
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:false}}}));
 await page.route('**/api/computer/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/targets'))return r.fulfill({json:{targets:[{windowId:7,ownerPid:9,bundleId:'test.app',name:'Fixture app',path:'/fixture'}]}});
  if(path.endsWith('/settings')){const b=r.request().postDataJSON();proactive=b.proactive;reactions=b.reactions;}
  if(path.endsWith('/start'))active=true;
  if(path.endsWith('/stop'))active=false;
  await r.fulfill({json:{active,plugin:'computer',observing:active,generation:23,proactive,reactions}});
 });
 await bootChat(page);await openTab(page,'桌面');await page.getByRole('button',{name:'查看授权'}).click();
 const modal=page.getByRole('dialog',{name:'桌面访问'});
 await modal.getByRole('button',{name:'查找窗口'}).click();await modal.getByRole('combobox').selectOption('7');
 await modal.getByRole('button',{name:'开启',exact:true}).click();
 await expect.poll(()=>active).toBe(true);
 await modal.getByRole('switch',{name:'主动发言'}).click();
 await expect.poll(()=>proactive).toBe(true);
 await page.keyboard.press('Escape');await page.reload();await openTab(page,'桌面');
 await expect(page.getByRole('button',{name:'返回对话'})).toBeVisible();
 await page.getByRole('button',{name:'查看授权'}).click();
 await modal.locator('.extension-detail-actions').getByRole('button',{name:'关闭',exact:true}).click();
 await expect.poll(()=>active).toBe(false);
});

test('unconfirmed native stop stays retryable instead of looking idle',async({page})=>{
 let stopUnconfirmed=true,stops=0;
 await page.route('**/api/computer/native/**',async r=>{
  if(r.request().url().endsWith('/stop')){stops++;stopUnconfirmed=false;}
  await r.fulfill({json:{active:false,stopUnconfirmed}});
 });
 await bootChat(page);await openTab(page,'桌面');await page.getByRole('button',{name:'查看授权'}).click();
 const modal=page.getByRole('dialog',{name:'桌面访问'});
 const stop=modal.locator('.extension-detail-actions').getByRole('button',{name:'关闭',exact:true});
 await expect(stop).toBeEnabled();await stop.click();
 await expect.poll(()=>stops).toBe(1);await expect(stop).toHaveCount(0);
});
