import {test,expect} from './fixtures';
import {bootChat,openTab} from './helpers';

test('chat and settings share proactive task replies',async({page})=>{
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
 await openTab(page,'对话');
 const proactiveSetting=page.locator('#config-dialogue').getByRole('switch',{name:'主动回应',exact:true});
 await expect(proactiveSetting).toHaveAttribute('aria-checked','false');
 await proactiveSetting.click();
 await expect.poll(()=>proactive&&reactions).toBe(true);
 await bootChat(page);
 await expect(page.getByRole('button',{name:'主动回应',exact:true})).toHaveAttribute('aria-pressed','true');
 await openTab(page,'操作');
 const operations=page.locator('#config-operations');
 await expect(operations.getByRole('switch',{name:'主动回应',exact:true})).toHaveCount(0);
 await expect(operations.getByRole('button',{name:'选择窗口'})).toHaveCount(0);
});
