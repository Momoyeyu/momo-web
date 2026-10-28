import {test,expect,type Page} from './fixtures';
import {openExtensionTab} from './helpers';
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const state=(status='idle')=>({provider:'qq',status,running:false,connected:false,actualSelfId:null as string|null,attemptId:null as string|null,error:null as string|null,executorQuiescent:true,qr:null as null|{dataUrl:string;expiresAt:number}});
const connected=()=>({...state('connected'),running:true,connected:true,executorQuiescent:false,actualSelfId:'123456',attemptId:'authenticated'});
const pending=(id='attempt-1',expiresAt=Date.now()+60000)=>({...state('qr_pending'),running:true,executorQuiescent:false,attemptId:id,qr:{dataUrl:PNG,expiresAt}});
const openQQ=async(page:Page)=>{
  await openExtensionTab(page,'插件');
  await page.locator('.official-plugins .social-card').getByRole('button',{name:'配置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});await expect(dialog).toBeVisible();return dialog;
};
const noExtraControls=async(page:Page)=>{
  const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});
  await expect(dialog.getByRole('button',{name:/^(刷新二维码|重新扫码|取消登录|保存并启用 QQ 聊天|保存|取消|核对后恢复新消息|生成核验口令|检查核验结果)$/})).toHaveCount(0);
  await expect(dialog.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toHaveCount(0);
  await expect(dialog.locator('#social-panel-account input')).toHaveCount(0);
};

test('closing and reopening preferences keeps old and new editor writes in one order',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:false};const writes:Record<string,any>[]=[];let release:(()=>void)|undefined;
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:state()}));
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    const body=route.request().postDataJSON();writes.push(body);
    if(writes.length===1)await new Promise<void>(resolve=>{release=resolve;});
    account={...account,...body,permissions:{...account.permissions,...body.permissions},policyRevision:account.policyRevision+1};
    await route.fulfill({json:account});
  });
  let dialog=await openQQ(page);await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  await dialog.getByRole('switch',{name:'回复文字',exact:true}).click();
  await expect.poll(()=>writes.length).toBe(1);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  dialog=await openQQ(page);await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  const reply=dialog.getByRole('switch',{name:'回复文字',exact:true});
  await expect(reply).toHaveAttribute('aria-checked','true');await reply.click();await reply.click();
  await page.waitForTimeout(600);
  expect(writes).toEqual([{permissions:{reply:false}}]);
  release!();await expect.poll(()=>writes.length).toBe(2);
  await expect(dialog.locator('.social-save-state')).toContainText('已保存');
  expect(writes[1]).toEqual({permissions:{reply:true}});
  expect(account.permissions.reply).toBe(true);expect(account.enabled).toBe(false);
  await expect(reply).toHaveAttribute('aria-checked','true');
});

test('a failed initial account read recovers automatically without a Retry action',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let reads=0;
  await page.route(/\/api\/social\/accounts$/,async route=>{
    reads++;
    if(reads===1){await route.fulfill({status:503,json:{detail:'Synthetic temporary configuration outage'}});return;}
    await route.fulfill({json:{accounts:[initial],providers:[]}});
  });
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:state()}));
  await openExtensionTab(page,'插件');
  const card=page.locator('.official-plugins .social-card');
  await expect(card.getByRole('button',{name:'配置',exact:true})).toBeEnabled({timeout:15000});
  expect(reads).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.official-plugins').getByRole('button',{name:'重试',exact:true})).toHaveCount(0);
  await expect(card.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toBeDisabled();
});

test('unknown native status offers no lifecycle action and cannot enable QQ',async({page})=>{
  let release:(()=>void)|undefined;
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,async route=>{
    await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({json:state()});
  });
  const dialog=await openQQ(page);
  await expect(dialog.getByText('正在读取登录状态…',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:/^(登录 QQ|退出登录)$/})).toHaveCount(0);
  await expect(page.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toBeDisabled();
  await expect.poll(()=>typeof release).toBe('function');release!();
  await expect(dialog.getByRole('button',{name:'登录 QQ',exact:true})).toBeEnabled();
});

test('Login is auth-only and supports a cached session without promising a QR',async({page,request})=>{
  let runtime=state();const actions:string[]=[];let connects=0;
  await page.route(/\/api\/social\/accounts\/qq\/connect$/,route=>{connects++;return route.abort();});
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){actions.push(route.request().url().split('/').at(-1)!);expect(route.request().postDataJSON()).toEqual({});runtime=connected();}
    await route.fulfill({json:runtime});
  });
  const original=(await (await request.get('/api/social/accounts')).json()).accounts;
  const dialog=await openQQ(page);await noExtraControls(page);
  await expect(dialog.getByRole('button',{name:'退出登录',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'登录 QQ',exact:true}).click();
  await expect(dialog.getByText('QQ 已登录',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'退出登录',exact:true})).toBeEnabled();
  await expect(dialog.getByRole('button',{name:'登录 QQ',exact:true})).toHaveCount(0);
  await expect(dialog.locator('.qq-login img')).toHaveCount(0);
  expect(actions).toEqual(['begin']);expect(connects).toBe(0);
  expect((await (await request.get('/api/social/accounts')).json()).accounts).toEqual(original);
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
});

test('QR automatically updates through one shared observer; tabs and Close never cancel login',async({page,request},info)=>{
  let runtime=state();let reads=0;let inFlight=0;let maxInFlight=0;const actions:string[]=[];
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){actions.push(route.request().url().split('/').at(-1)!);runtime=pending();}
    else{reads++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(resolve=>setTimeout(resolve,80));inFlight--;}
    await route.fulfill({json:runtime});
  });
  let dialog=await openQQ(page);await dialog.getByRole('button',{name:'登录 QQ',exact:true}).click();
  await expect(dialog.locator('.qq-login img')).toBeVisible();await noExtraControls(page);
  await expect(dialog.getByRole('button',{name:'正在登录…',exact:true})).toBeDisabled();
  await page.screenshot({path:info.outputPath('qq-login-qr.png')});
  runtime=pending('attempt-2',Date.now()+90000);
  await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  const before=reads;await page.waitForTimeout(1500);expect(reads-before).toBeLessThanOrEqual(2);
  await dialog.getByRole('tab',{name:'账号',exact:true}).click();
  await expect(dialog.locator('.qq-login-expiry')).toContainText(/8\d 秒后过期/);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).toHaveCount(0);
  dialog=await openQQ(page);await expect(dialog.locator('.qq-login img')).toBeVisible();
  expect(maxInFlight).toBe(1);expect(actions).toEqual(['begin']);
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
});

test('resource and identity errors remain safe and never offer Logout or enable QQ',async({page},info)=>{
  let runtime={...state('error'),error:'RESOURCE_UNAVAILABLE'};
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){runtime={...state('identity_mismatch'),error:'ACCOUNT_MISMATCH'};await route.fulfill({status:409,json:{detail:{code:'ACCOUNT_MISMATCH',message:'/private/session-token'}}});return;}
    await route.fulfill({json:runtime});
  });
  const dialog=await openQQ(page);await expect(dialog.getByRole('alert').filter({hasText:'QQ 组件尚未就绪'})).toBeVisible();
  await dialog.getByRole('button',{name:'登录 QQ',exact:true}).click();
  await expect(dialog.getByRole('alert').filter({hasText:'登录账号与已绑定账号不同'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'退出登录',exact:true})).toHaveCount(0);await expect(dialog).not.toContainText('/private/session-token');
  await expect(page.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toBeDisabled();
  await page.screenshot({path:info.outputPath('qq-login-error.png')});
});

test('Logout immediately disables the plugin and clears login with one action, without a second confirmation',async({page,request},info)=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:true,expectedSelfId:'123456',actualSelfId:'123456',status:'connected'};let runtime=connected();
  const actions:string[]=[];let connects=0;let hold=false;let release:(()=>void)|undefined;
  await page.route(/\/api\/social\/accounts$/,async route=>{if(hold){hold=false;await new Promise<void>(resolve=>{release=resolve;});}await route.fulfill({json:{accounts:[account],providers:[]}});});
  await page.route(/\/api\/social\/accounts\/qq\/connect$/,route=>{connects++;return route.abort();});
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){actions.push(route.request().url().split('/').at(-1)!);account={...account,enabled:false,status:'disabled'};runtime=state() as ReturnType<typeof connected>;hold=true;}
    await route.fulfill({json:runtime});
  });
  const dialog=await openQQ(page);await expect(dialog.getByRole('button',{name:'退出登录',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect.poll(()=>typeof release).toBe('function');
  await expect(dialog.getByRole('button',{name:'登录 QQ',exact:true})).toBeDisabled();release!();
  await expect(dialog.getByRole('button',{name:'登录 QQ',exact:true})).toBeEnabled();
  await expect(dialog.getByRole('button',{name:'退出登录',exact:true})).toHaveCount(0);
  await expect(page.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toHaveAttribute('aria-checked','false');
  expect(actions).toEqual(['forget']);expect(connects).toBe(0);expect(account.permissions).toEqual(initial.permissions);await noExtraControls(page);
  await page.screenshot({path:info.outputPath('qq-logged-out.png')});
});

for(const disabled of [true,false])test(`failed Logout re-reads actual ${disabled?'OFF':'still ON'} state`,async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:true,expectedSelfId:'123456',actualSelfId:'123456',status:'connected'};
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){if(disabled)account={...account,enabled:false,status:'disabled'};await route.fulfill({status:409,json:{detail:{code:'FORGET_FAILED'}}});return;}
    await route.fulfill({json:connected()});
  });
  const dialog=await openQQ(page);await dialog.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(dialog.getByRole('alert').filter({hasText:'未能移除登录会话'})).toBeVisible();
  await expect(page.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toHaveAttribute('aria-checked',String(!disabled));
});

test('the sole plugin switch turns ON only when logged in; OFF stays available after native disconnect',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:false,expectedSelfId:'123456',status:'disabled'};let runtime=state();const actions:string[]=[];
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:runtime}));
  await page.route(/\/api\/social\/accounts\/qq\/(connect|disconnect)$/,async route=>{
    const action=route.request().url().split('/').at(-1)!;actions.push(action);expect(route.request().postDataJSON()).toEqual({});
    account={...account,enabled:action==='connect',status:action==='connect'?'connected':'disabled'};await route.fulfill({json:account});
  });
  await openExtensionTab(page,'插件');const enabled=page.getByRole('switch',{name:'启用 QQ 收发',exact:true});await expect(enabled).toBeDisabled();
  runtime=connected();await expect(enabled).toBeEnabled();await enabled.click();await expect(enabled).toHaveAttribute('aria-checked','true');
  runtime=state('disconnected');await page.waitForTimeout(1400);await expect(enabled).toBeEnabled();await enabled.click();
  await expect(enabled).toHaveAttribute('aria-checked','false');await expect(enabled).toBeDisabled();expect(actions).toEqual(['connect','disconnect']);
  expect(account.permissions).toEqual(initial.permissions);expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
});

test('permissions autosave only changed fields, serialize newer edits and never reactivate after Logout',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:true,expectedSelfId:'123456',actualSelfId:'123456',status:'connected'};let runtime=connected();
  const writes:Record<string,any>[]=[];let release:(()=>void)|undefined;let first=true;let connects=0;
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    const body=route.request().postDataJSON();writes.push(body);expect(body).not.toHaveProperty('enabled');expect(body).not.toHaveProperty('expectedSelfId');
    if(first){first=false;await new Promise<void>(resolve=>{release=resolve;});}
    account={...account,...body,permissions:{...account.permissions,...body.permissions},policyRevision:account.policyRevision+1};await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/connect$/,route=>{connects++;return route.abort();});
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){account={...account,enabled:false,status:'disabled'};runtime=state() as ReturnType<typeof connected>;}
    await route.fulfill({json:runtime});
  });
  const dialog=await openQQ(page);await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  const reply=dialog.getByRole('switch',{name:'回复文字',exact:true});await reply.click();await expect.poll(()=>writes.length).toBe(1);
  await reply.click();await dialog.getByRole('switch',{name:'收取私聊',exact:true}).click();
  await dialog.getByRole('tab',{name:'账号',exact:true}).click();await dialog.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'登录 QQ',exact:true})).toBeEnabled();release!();
  await expect.poll(()=>writes.length).toBe(2);await expect(dialog.locator('.social-save-state')).toContainText('已保存');
  expect(writes).toEqual([{permissions:{reply:false}},{permissions:{reply:true,receive:false}}]);
  expect(account.enabled).toBe(false);expect(connects).toBe(0);await expect(page.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toHaveAttribute('aria-checked','false');
  await dialog.getByRole('tab',{name:'权限',exact:true}).click();await expect(reply).toHaveAttribute('aria-checked','true');
  await expect(dialog.getByRole('switch',{name:'收取私聊',exact:true})).toHaveAttribute('aria-checked','false');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
});

test('a rejected preference save reads actual settings and rolls back only the failed edit',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];const account={...initial,enabled:false};let reads=0;
  await page.route(/\/api\/social\/accounts$/,route=>{reads++;return route.fulfill({json:{accounts:[account],providers:[]}});});
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:state()}));
  await page.route(/\/api\/social\/accounts\/qq$/,route=>route.fulfill({status:409,json:{detail:'denied'}}));
  const dialog=await openQQ(page);await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  const before=reads;const reply=dialog.getByRole('switch',{name:'回复文字',exact:true});await reply.click();
  await expect(dialog.getByRole('alert')).toContainText('未能保存');await expect(reply).toHaveAttribute('aria-checked','true');expect(reads).toBeGreaterThan(before);
  await expect(page.getByRole('switch',{name:'启用 QQ 收发',exact:true})).toHaveAttribute('aria-checked','false');
});

test('identity and unresolved records are read-only with no manual owner or delivery recovery workflow',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  const account={...initial,enabled:true,ownerPeerId:'verified-owner',status:'quarantined'};const mutations:string[]=[];
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:connected()}));
  let reads=0;let delivered=false;
  await page.route(/\/api\/social\/accounts\/qq\/records$/,route=>{
    reads++;return route.fulfill({json:{records:[{commandId:'unknown-command',peerId:'peer',status:delivered?'completed':'unknown',executorQuiescent:true}]}});
  });
  await page.route(/\/api\/social\/accounts\/qq\/(reconcile|resume|owner-challenge)$/,route=>{mutations.push(route.request().url());return route.abort();});
  const dialog=await openQQ(page);await expect(dialog.getByText('已核验玩家：verified-owner',{exact:true})).toBeVisible();await noExtraControls(page);
  await dialog.getByRole('tab',{name:'记录',exact:true}).click();await expect(dialog.getByText('unknown-command',{exact:true})).toBeVisible();
  await expect(dialog.getByText('结果未知',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:/标记|结束未知|重发/})).toHaveCount(0);expect(mutations).toEqual([]);
  await expect(dialog.getByRole('button',{name:'刷新',exact:true})).toHaveCount(0);
  const before=reads;delivered=true;
  await expect(dialog.getByText('操作完成',{exact:true})).toBeVisible({timeout:15000});
  expect(reads).toBeGreaterThan(before);expect(mutations).toEqual([]);
});
