import {test,expect} from './fixtures';
import {bootChat,openTab} from './helpers';

test('browser settings find existing windows, start and stop the selected native target',async({page})=>{
 let active=false;
 const target={windowId:7,ownerPid:9,bundleId:'test.browser',name:'Test browser',path:'/fixture'};
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:false}}}));
 await page.route('**/api/computer/native/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/targets'))return r.fulfill({json:{targets:[target],screenPermission:true,inputPermission:true}});
  if(path.endsWith('/start')){
   expect(r.request().postDataJSON()).toMatchObject({windowId:7,ownerPid:9,plugin:'browser'});
   active=true;
  }
  if(path.endsWith('/stop'))active=false;
  await r.fulfill({json:{active,plugin:'browser',target:active?target:undefined}});
 });
 await bootChat(page);await openTab(page,'浏览器');
 await page.getByRole('button',{name:'选择窗口'}).click();
 const config=page.getByRole('dialog',{name:'浏览器窗口'});
 await config.getByRole('button',{name:'查找窗口'}).click();
 await config.getByRole('combobox').selectOption('7');
 await config.getByRole('button',{name:'开启',exact:true}).click();
 await expect.poll(()=>active).toBe(true);
 await page.keyboard.press('Escape');
 await expect(page.locator('#config-browser .config-value')).toHaveText('Test browser');
 await page.getByRole('button',{name:'选择窗口'}).click();
 await config.locator('.extension-detail-actions').getByRole('button',{name:'关闭',exact:true}).click();
 await expect.poll(()=>active).toBe(false);
});

test('missing screen permission explains how to find the window',async({page})=>{
 await page.route('**/api/computer/native/targets',r=>r.fulfill({json:{targets:[],screenPermission:false,inputPermission:true}}));
 await bootChat(page);await openTab(page,'浏览器');await page.getByRole('button',{name:'选择窗口'}).click();
 const dialog=page.getByRole('dialog',{name:'浏览器窗口'});
 await dialog.getByRole('button',{name:'查找窗口'}).click();
 await expect(dialog).toContainText('需要屏幕录制权限');
 await expect(dialog.getByRole('button',{name:'开启',exact:true})).toBeDisabled();
});
