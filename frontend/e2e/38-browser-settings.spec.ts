import {test,expect} from './fixtures';
import {bootChat,openExtensionTab} from './helpers';
for(const decision of ['once','always','deny'])test(`existing browser requires ${decision} decision before starting`,async({page},info)=>{
 let active=false,allowed=false,pending=false;const decisions:string[]=[];
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:true}}}));
 await page.route('**/api/computer/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/targets')){await r.fulfill({json:{targets:[{windowId:7,ownerPid:9,bundleId:'test.browser',name:'Test browser',path:'/fixture'}]}});return;}
  if(path.endsWith('/decision')){const d=r.request().postDataJSON().decision;decisions.push(d);allowed=d!=='deny';pending=false;await r.fulfill({json:{status:d}});return;}
  if(path.endsWith('/approvals')){await r.fulfill({json:{pending:pending?[{id:'request',appId:'test',appName:'Test browser',bundleId:'test.browser',reason:'Read this window',capabilities:['observe'],status:'pending'}]:[],allowlist:[]}});return;}
  if(path.endsWith('/resume')){expect(r.request().postDataJSON().requestId).toBe('request');expect(allowed).toBe(true);active=true;}
  if(path.endsWith('/start')){if(!allowed){pending=true;await r.fulfill({json:{approvalRequired:true,requestId:'request',status:'pending'}});return;}active=true;}
  if(path.endsWith('/stop'))active=false;
  await r.fulfill({json:{active,plugin:'browser'}});
 });
 await bootChat(page);await openExtensionTab(page,'插件');
 await page.locator('.extension-card').filter({hasText:'浏览器'}).getByRole('button',{name:'配置',exact:true}).click();
 const config=page.getByRole('dialog',{name:'浏览器',exact:true});
 await config.getByRole('button',{name:'查找窗口'}).click();await config.getByRole('combobox').selectOption('7');await config.getByRole('button',{name:'开启',exact:true}).click();
 const approval=page.getByRole('dialog',{name:'应用授权',exact:true});await expect(approval).toBeVisible();expect(active).toBe(false);
 await page.screenshot({path:info.outputPath('permission.png')});
 await approval.getByRole('button',{name:decision==='once'?'仅允许本次':decision==='always'?'始终允许':'拒绝',exact:true}).click();
 await expect.poll(()=>decisions).toEqual([decision]);
 if(decision!=='deny'){await expect.poll(()=>active).toBe(true);await config.getByRole('button',{name:'关闭',exact:true}).click();await expect.poll(()=>active).toBe(false);}else await expect(config.getByRole('button',{name:'开启',exact:true})).toBeEnabled();
});
test('model-origin approval resumes server request after explicit waiting only',async({page})=>{
 let pending=false,resumes=0;
 await page.route('**/api/computer/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/approvals')){await r.fulfill({json:{pending:pending?[{id:'model-request',appId:'test',appName:'Test app',bundleId:'test.app',reason:'Observe for reply',capabilities:['observe'],status:'pending'}]:[],allowlist:[]}});return;}
  if(path.endsWith('/decision')){pending=false;await r.fulfill({json:{status:'allowed'}});return;}
  if(path.endsWith('/resume')){expect(r.request().postDataJSON().requestId).toBe('model-request');resumes++;await r.fulfill({json:resumes===1?{waiting:true}:{active:true}});return;}
  await r.fulfill({json:{active:false}});
 });
 await bootChat(page);pending=true;
 const approval=page.getByRole('dialog',{name:'应用授权',exact:true});await expect(approval).toBeVisible();
 await approval.getByRole('button',{name:'仅允许本次',exact:true}).click();
 await expect.poll(()=>resumes).toBe(2);
 await expect(approval).toHaveCount(0);
});
