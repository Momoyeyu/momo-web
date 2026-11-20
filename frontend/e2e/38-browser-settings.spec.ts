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
 const config=page.locator('#config-browser');
 await config.getByRole('button',{name:'查找窗口'}).click();
 await config.getByRole('combobox').selectOption('7');
 await config.getByRole('button',{name:'开启',exact:true}).click();
 await expect.poll(()=>active).toBe(true);
 await expect(config.getByText('Test browser · 7',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await config.getByRole('button',{name:'关闭',exact:true}).click();
 await expect.poll(()=>active).toBe(false);
});

test('missing screen permission explains how to find the window',async({page})=>{
 await page.route('**/api/computer/native/targets',r=>r.fulfill({json:{targets:[],screenPermission:false,inputPermission:true}}));
 await bootChat(page);await openTab(page,'浏览器');
 const config=page.locator('#config-browser');
 await config.getByRole('button',{name:'查找窗口'}).click();
 await expect(config).toContainText('需要屏幕录制权限');
 await expect(config.getByRole('button',{name:'开启',exact:true})).toBeDisabled();
});

test('browser status recovers after a failed poll and keeps separate action errors',async({page})=>{
 let statusUnavailable=true, scanUnavailable=true, successfulPolls=0;
 await page.route('**/api/computer/native/status',route=>{
  if(statusUnavailable)return route.fulfill({status:503,json:{}});
  successfulPolls++;
  return route.fulfill({json:{active:false}});
 });
 await page.route('**/api/computer/native/targets',route=>scanUnavailable
  ? route.fulfill({status:503,json:{}})
  : route.fulfill({json:{targets:[],screenPermission:true,inputPermission:true}}));
 await bootChat(page);
 await openTab(page,'浏览器');
 const config=page.locator('#config-browser');
 await expect(config.getByText('读取失败，请重试。',{exact:true})).toBeVisible();
 statusUnavailable=false;
 await expect(config.getByText('已关闭',{exact:true})).toBeVisible();
 await expect(config.getByRole('alert')).toHaveCount(0);

 await config.getByRole('button',{name:'查找窗口'}).click();
 const error=config.getByRole('alert');
 await expect(error).toHaveText('授权操作失败，请重试。');
 const previous=successfulPolls;
 await expect.poll(()=>successfulPolls).toBeGreaterThan(previous);
 await expect(error).toBeVisible();
 scanUnavailable=false;
 await config.getByRole('button',{name:'查找窗口'}).click();
 await expect(error).toHaveCount(0);
});
