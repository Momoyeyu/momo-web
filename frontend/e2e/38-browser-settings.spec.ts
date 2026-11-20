import {test,expect} from './fixtures';
import {bootChat,openTab} from './helpers';

test('browser windows can be selected before Boot, then connected and stopped from a conversation',async({page})=>{
 let active=false;
 const target={windowId:7,ownerPid:9,bundleId:'test.browser',name:'Test browser',path:'/fixture',title:'A long fixture window title '.repeat(12).trim()};
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:false}}}));
 await page.route('**/api/computer/native/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/targets')){
   expect(r.request().postDataJSON()).toEqual({plugin:'browser'});
   return r.fulfill({json:{targets:[target],screenPermission:true,inputPermission:true}});
  }
  if(path.endsWith('/start')){
   expect(r.request().postDataJSON()).toMatchObject({windowId:7,ownerPid:9,plugin:'browser'});
   active=true;
  }
  if(path.endsWith('/stop'))active=false;
  await r.fulfill({json:{active,plugin:'browser',target:active?target:undefined}});
 });
 await openTab(page,'浏览器');
 const config=page.locator('#config-browser');
 await expect(page.getByRole('button',{name:'返回标题'})).toBeVisible();
 await config.getByRole('button',{name:'查找窗口'}).click();
 const picker=config.getByRole('button',{name:/^应用窗口 ·/});
 const emptyWidth=(await picker.boundingBox())!.width;
 await picker.click();
 const option=config.getByRole('option',{name:/^Test browser/});
 await expect(option).toHaveAttribute('title', 'Test browser · '+target.title);
 await option.click();
 expect((await picker.boundingBox())!.width).toBeCloseTo(emptyWidth);
 expect(emptyWidth).toBeLessThanOrEqual(230);
 await expect(config.getByText('已选好窗口。进入对话后可以连接。')).toBeVisible();
 await expect(config.getByRole('button',{name:'开启',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'返回标题'}).click();
 await page.locator('.title-menu .menu-item').first().click();
 await expect(page.locator('.chat-page')).toBeVisible();
 await openTab(page,'浏览器');
 await expect(picker).toHaveAccessibleName(/Test browser/);
 await config.getByRole('button',{name:'开启',exact:true}).click();
 await expect.poll(()=>active).toBe(true);
 await expect(config.getByText('Test browser · '+target.title,{exact:true})).toBeVisible();
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
