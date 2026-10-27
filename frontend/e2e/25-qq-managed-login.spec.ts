import {test,expect,type Page} from './fixtures';
import {openExtensionTab} from './helpers';

const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const state=(status='idle')=>({provider:'qq',status,running:false,connected:false,actualSelfId:null as string|null,attemptId:null as string|null,error:null as string|null,executorQuiescent:true,qr:null as null|{dataUrl:string;expiresAt:number}});
const pending=(attemptId='attempt-1',expiresAt=Date.now()+60000)=>({...state('qr_pending'),running:true,executorQuiescent:false,attemptId,qr:{dataUrl:PNG,expiresAt}});
const openQQ=async(page:Page)=>{
  await openExtensionTab(page,'插件');
  await page.locator('.official-plugins .social-card').getByRole('button',{name:'配置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});
  await expect(dialog).toBeVisible();
  return dialog;
};

test('native QQ login stays inside settings and does not enable messaging or Boot momo',async({page,request},info)=>{
  let runtime=state();let reads=0;const actions:string[]=[];
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='GET')reads++;
    else{
      const action=route.request().url().split('/').at(-1)!;actions.push(action);
      expect(route.request().postDataJSON()).toEqual({});
      runtime=action==='cancel'?state('cancelled'):pending(action==='refresh'?'attempt-2':'attempt-1');
    }
    await route.fulfill({json:runtime,headers:{'cache-control':'no-store'}});
  });
  const original=(await (await request.get('/api/social/accounts')).json()).accounts;
  let dialog=await openQQ(page);
  await expect(dialog.getByText('让 momo 登录自己的 QQ 账号。',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'重新扫码',exact:true})).toHaveCount(0);
  await expect(dialog.getByText('桥接地址',{exact:true})).not.toBeVisible();
  await dialog.getByRole('button',{name:'扫码登录',exact:true}).click();
  await expect(dialog.getByRole('img',{name:'用手机 QQ 扫描此二维码登录 momo 的账号',exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('qq-native-qr.png')});
  await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  const pausedReads=reads;await page.waitForTimeout(1500);expect(reads).toBe(pausedReads);
  await expect(dialog.locator('.qq-login img')).toHaveCount(0);
  // Expire the first QR deliberately; tracing and close/reopen latency must not
  // consume the lifetime of the fresh QR used in the later persistence check.
  runtime={...runtime,qr:runtime.qr?{...runtime.qr,expiresAt:Date.now()-1}:null};
  await dialog.getByRole('tab',{name:'账号',exact:true}).click();
  await expect(dialog.getByText('二维码已过期，请刷新。',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'刷新二维码',exact:true}).click();
  await expect(dialog.locator('.qq-login img')).toBeVisible();
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(actions).toEqual(['begin','refresh']); // Closing observes no logout/cancel.
  dialog=await openQQ(page);
  await expect(dialog.locator('.qq-login img')).toBeVisible();
  await dialog.getByRole('button',{name:'取消登录',exact:true}).click();
  await expect(dialog.getByText('本次登录已取消。',{exact:true})).toBeVisible();
  await expect(dialog.locator('.qq-login img')).toHaveCount(0);
  expect(actions).toEqual(['begin','refresh','cancel']);
  expect((await (await request.get('/api/social/accounts')).json()).accounts).toEqual(original);
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
});

test('unavailable resources and mismatched identities never appear as a logged-in account',async({page},info)=>{
  let runtime={...state('error'),error:'RESOURCE_UNAVAILABLE'};
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){
      runtime={...state('identity_mismatch'),error:'ACCOUNT_MISMATCH'};
      await route.fulfill({status:409,json:{detail:{code:'ACCOUNT_MISMATCH',message:'/private/session-token'}}});return;
    }
    await route.fulfill({json:runtime});
  });
  const dialog=await openQQ(page);
  await expect(dialog.getByRole('alert').filter({hasText:'QQ 组件尚未就绪'})).toBeVisible();
  await dialog.getByRole('button',{name:'扫码登录',exact:true}).click();
  await expect(dialog.getByRole('alert').filter({hasText:'登录账号与已绑定账号不同'})).toBeVisible();
  await expect(dialog.getByText('QQ 已登录',{exact:true})).toHaveCount(0);
  await expect(dialog.locator('.qq-login img')).toHaveCount(0);
  await expect(dialog).not.toContainText('/private/session-token');
  await page.screenshot({path:info.outputPath('qq-native-identity-mismatch.png')});
});

test('forgetting QQ sign-in requires explicit confirmation and is independent of policy settings',async({page,request},info)=>{
  let runtime={...state('connected'),connected:true,running:true,executorQuiescent:false,actualSelfId:'123456',attemptId:'authenticated'};
  const actions:string[]=[];
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST'){
      actions.push(route.request().url().split('/').at(-1)!);
      await route.fulfill({json:state()});return;
    }
    await route.fulfill({json:runtime});
  });
  const original=(await (await request.get('/api/social/accounts')).json()).accounts;
  const dialog=await openQQ(page);
  await expect(dialog.getByText('QQ 已登录',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'重新扫码',exact:true})).toHaveCount(0);
  await expect(dialog.getByText('已核验账号：123456',{exact:true})).toBeVisible();
  await dialog.locator('.qq-login-session summary').click();
  await dialog.getByRole('button',{name:'忘记登录',exact:true}).click();
  await expect(dialog.getByText('移除 momo 保存的 QQ 登录凭据？聊天记录、记忆和账号权限会保留。',{exact:true})).toBeVisible();
  expect(actions).toEqual([]);
  await page.screenshot({path:info.outputPath('qq-native-forget-confirmation.png')});
  runtime={...runtime,status:'idle',connected:false,running:false};
  await dialog.locator('.qq-login-forget-confirm').getByRole('button',{name:'忘记登录',exact:true}).click();
  await expect(dialog.getByText('让 momo 登录自己的 QQ 账号。',{exact:true})).toBeVisible();
  expect(actions).toEqual(['forget']);
  expect((await (await request.get('/api/social/accounts')).json()).accounts).toEqual(original);
});

test('verified native login enables QQ chat only after explicitly saving the displayed grants',async({page,request},info)=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:false,transport:'managed',expectedSelfId:'',actualSelfId:null,status:'disabled'};
  const saved:Record<string,unknown>[]=[];const connections:unknown[]=[];
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    const body=route.request().postDataJSON();saved.push(body);
    expect(body).not.toHaveProperty('enabled');
    account={...account,...body};await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/connect$/,async route=>{
    const body=route.request().postDataJSON();connections.push(body);
    expect(body).toEqual({});
    account={...account,transport:'managed',enabled:true,expectedSelfId:'123456',actualSelfId:'123456',status:'connected'};
    await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:{...state('connected'),connected:true,running:true,executorQuiescent:false,actualSelfId:'123456',attemptId:'authenticated'}}));
  const dialog=await openQQ(page);
  await expect(dialog.getByText('QQ 已登录',{exact:true})).toBeVisible();
  expect(saved).toEqual([]);expect(connections).toEqual([]);
  await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  const reply=dialog.getByRole('switch',{name:'回复文字',exact:true});
  await expect(reply).toHaveAttribute('aria-checked','true');await reply.click();
  await dialog.locator('.social-allowlist').getByRole('switch').click();
  await dialog.getByRole('tab',{name:'账号',exact:true}).click();
  await dialog.getByRole('button',{name:'保存并启用 QQ 聊天',exact:true}).click();
  await expect(dialog.getByText('QQ 聊天已连接',{exact:true})).toBeVisible();
  expect(saved).toHaveLength(1);expect(connections).toEqual([{}]);
  expect(saved[0]).toMatchObject({permissions:{receive:true,reply:false},allowlistEnabled:true,allowlist:[]});
  await expect(dialog.getByRole('switch',{name:'启用插件',exact:true})).toHaveAttribute('aria-checked','true');
  await expect(dialog.locator('#social-panel-account > .opt-row').filter({hasText:'momo 的账号 ID'}).locator('input')).toHaveValue('123456');
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
  await page.screenshot({path:info.outputPath('qq-native-chat-enabled.png')});
});

test('managed QQ can be disabled and explicitly re-enabled without changing grants or Boot',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:true,transport:'managed',expectedSelfId:'123456',actualSelfId:'123456',status:'connected'};
  const writes:Record<string,unknown>[]=[];let connects=0;
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    const body=route.request().postDataJSON();writes.push(body);account={...account,...body};
    account.status=account.enabled?'connected':'disabled';await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/connect$/,async route=>{
    expect(route.request().postDataJSON()).toEqual({});connects++;
    account={...account,enabled:true,status:'connected'};await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:{...state('connected'),connected:true,running:true,executorQuiescent:false,actualSelfId:'123456',attemptId:'authenticated'}}));
  await openExtensionTab(page,'插件');
  const enabled=page.getByRole('switch',{name:'启用 QQ',exact:true});
  await enabled.click();await expect(enabled).toHaveAttribute('aria-checked','false');
  await enabled.click();await expect(enabled).toHaveAttribute('aria-checked','true');
  expect(connects).toBe(1);expect(writes.every(body=>body.enabled===false)).toBe(true);
  await enabled.click();await expect(enabled).toHaveAttribute('aria-checked','false');
  await page.locator('.official-plugins .social-card').getByRole('button',{name:'配置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});
  await dialog.getByRole('switch',{name:'启用插件',exact:true}).click();
  await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await expect(dialog).toHaveCount(0);await expect(enabled).toHaveAttribute('aria-checked','true');
  expect(connects).toBe(2);expect(writes.at(-1)).not.toHaveProperty('enabled');
  expect(account.permissions).toEqual(initial.permissions);
  expect(account.allowlistEnabled).toBe(initial.allowlistEnabled);
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
});

test('disconnecting QQ chat keeps it disabled when saving other unsaved policy edits',async({page,request})=>{
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,enabled:true,transport:'managed',expectedSelfId:'123456',actualSelfId:'123456',status:'connected'};
  const writes:Record<string,unknown>[]=[];let connects=0;let disconnects=0;
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    const body=route.request().postDataJSON();writes.push(body);account={...account,...body};
    await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/connect$/,async route=>{
    connects++;account={...account,enabled:true,status:'connected'};
    await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/disconnect$/,async route=>{
    disconnects++;account={...account,enabled:false,status:'disabled'};
    await route.fulfill({json:account});
  });
  await page.route(/\/api\/social\/accounts\/qq\/runtime$/,route=>route.fulfill({json:{...state('connected'),connected:true,running:true,executorQuiescent:false,actualSelfId:'123456',attemptId:'authenticated'}}));
  const dialog=await openQQ(page);
  await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  const reply=dialog.getByRole('switch',{name:'回复文字',exact:true});
  await expect(reply).toHaveAttribute('aria-checked','true');await reply.click();
  await dialog.getByRole('tab',{name:'账号',exact:true}).click();
  await dialog.getByRole('button',{name:'断开连接',exact:true}).click();
  await expect(dialog.getByRole('switch',{name:'启用插件',exact:true})).toHaveAttribute('aria-checked','false');
  await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  expect(disconnects).toBe(1);expect(connects).toBe(0);
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({enabled:false,permissions:{reply:false}});
  expect(account.enabled).toBe(false);
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
});

for(const status of ['error','verifying']){
  test(`an existing ${status} login can explicitly start a fresh QR instead of restoring the cached session`,async({page})=>{
    let runtime={...state(status),running:status==='verifying',executorQuiescent:status!=='verifying',attemptId:status==='verifying'?'cached-attempt':null,error:status==='error'?'RUNTIME_TIMEOUT':null};
    const actions:string[]=[];
    await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
      if(route.request().method()==='POST'){
        actions.push(route.request().url().split('/').at(-1)!);
        runtime={...pending('fresh-attempt'),error:null};
      }
      await route.fulfill({json:runtime});
    });
    const dialog=await openQQ(page);
    const fresh=dialog.getByRole('button',{name:'重新扫码',exact:true});
    await expect(fresh).toBeEnabled();
    await expect(fresh).toHaveClass('ghost small');
    await fresh.click();
    await expect(dialog.locator('.qq-login img')).toBeVisible();
    expect(actions).toEqual(['refresh']);
  });
}

test('fresh QR respects dirty identity, pending action, account save and stopping guards',async({page,request})=>{
  let runtime={...state('verifying'),running:true,executorQuiescent:false,attemptId:'cached-attempt'};
  let releaseRefresh:()=>void=()=>{};
  let releaseSave:()=>void=()=>{};
  const original=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  await page.route(/\/api\/social\/accounts\/qq\/runtime(?:\/[^/?]+)?$/,async route=>{
    if(route.request().method()==='POST')await new Promise<void>(resolve=>{releaseRefresh=resolve;});
    await route.fulfill({json:runtime});
  });
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    await new Promise<void>(resolve=>{releaseSave=resolve;});
    await route.fulfill({json:original});
  });
  let dialog=await openQQ(page);
  const fresh=()=>dialog.getByRole('button',{name:'重新扫码',exact:true});
  const identity=dialog.locator('#social-panel-account > .opt-row').filter({hasText:'momo 的账号 ID'}).locator('input');
  await expect(fresh()).toBeEnabled();
  await identity.fill('654321');
  await expect(fresh()).toBeDisabled();
  await identity.fill(original.expectedSelfId);
  await expect(fresh()).toBeEnabled();
  await fresh().click();
  await expect(fresh()).toHaveCount(0);
  releaseRefresh();
  await expect(fresh()).toBeEnabled();
  await dialog.getByRole('button',{name:'保存',exact:true}).click();
  await expect(fresh()).toBeDisabled();
  releaseSave();
  await expect(dialog).toHaveCount(0);
  runtime={...runtime,status:'stopping'};
  dialog=await openQQ(page);
  await expect(fresh()).toBeDisabled();
});
