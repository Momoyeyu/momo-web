import {test,expect} from './fixtures';
import {bootChat,openExtensionTab,waitForChatReady} from './helpers';

test('cold routes stay dormant until Boot, including settings and a direct chat URL',async({page,request})=>{
  await page.goto('/#/chat');
  await expect(page.locator('.title-screen')).toBeVisible();
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
  await openExtensionTab(page,'插件');
  await expect(page.locator('.official-plugins .social-card')).toHaveCount(1);
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
  await page.getByRole('button',{name:'返回标题',exact:true}).click();
  await bootChat(page);
  await waitForChatReady(page);
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('active');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.locator('.settings-page')).toBeVisible();
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('active');
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await page.getByRole('button',{name:'返回标题',exact:true}).click();
  await expect.poll(async()=> (await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
});

test('QQ account settings offer managed sign-in only and enforce an empty allowlist',async({page,request},info)=>{
  const accountsResponse=await request.get('/api/social/accounts');
  expect(accountsResponse.ok(),await accountsResponse.text()).toBe(true);
  const original=(await accountsResponse.json()).accounts as Array<{provider:string;allowlistEnabled:boolean;allowlist:Array<{peerId:string}>}>;
  expect(original.map(account=>account.provider)).toEqual(['qq']);
  expect(original.every(account=>account.allowlistEnabled===false)).toBe(true);
  try{
    await openExtensionTab(page,'插件');
    const cards=page.locator('.official-plugins .social-card');
    await expect(cards).toHaveCount(1);
    await expect(cards.getByRole('heading',{name:'QQ',exact:true})).toBeVisible();
    await cards.first().getByRole('button',{name:'配置'}).click();
    const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await expect(dialog.locator('input[placeholder^="ws:"]')).toHaveCount(0);
    await expect(dialog.getByText('高级连接（兼容旧桥接）',{exact:true})).toHaveCount(0);
    await expect(dialog.getByText('连接标识',{exact:true})).toHaveCount(0);
    await expect(dialog.locator('.qq-login')).toBeVisible();
    await expect(dialog.locator('.qq-login').locator('xpath=ancestor::details')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('qq-account.png')});
    await dialog.getByRole('tab',{name:'权限'}).click();
    await page.mouse.move(20,20);
    await page.waitForTimeout(450); // Let the horizontal tab transition finish for visual evidence.
    await page.screenshot({path:info.outputPath('qq-permissions.png')});
    await expect(dialog.getByRole('switch',{name:'主动私信'})).toBeDisabled();
    const policy=dialog.locator('.social-allowlist');
    await expect(policy.getByRole('switch')).toHaveAttribute('aria-checked','false');
    await policy.getByRole('switch').click();
    await expect(dialog.getByText('白名单为空，所有联系人均暂停处理。')).toBeVisible();
    await expect.poll(async()=>((await (await request.get('/api/social/accounts')).json()).accounts[0].allowlistEnabled)).toBe(true);
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    const saved=(await (await request.get('/api/social/accounts')).json()).accounts;
    expect(saved.find((item:{provider:string})=>item.provider==='qq').allowlistEnabled).toBe(true);
    expect(saved.find((item:{provider:string})=>item.provider==='qq').allowlist).toEqual([]);
    for(const key of ['endpoint','token','hasCredential'])expect(saved[0]).not.toHaveProperty(key);
    await cards.last().getByRole('button',{name:'配置'}).click();
    await expect(dialog).toBeVisible();
    await page.getByRole('dialog').getByRole('tab',{name:'记录'}).click();
    await expect(page.getByRole('dialog').getByText('还没有执行记录。')).toBeVisible();
  }finally{
    for(const account of original){
      await request.put(`/api/social/accounts/${account.provider}`,{data:{allowlistEnabled:account.allowlistEnabled,allowlist:account.allowlist}});
    }
  }
});

test('chat focus can be changed while text input remains available',async({page,request})=>{
  await bootChat(page);
  await waitForChatReady(page);
  const focus=page.getByRole('button',{name:'专注对话'});
  await expect(focus).toHaveAttribute('aria-pressed','false');
  await focus.click();
  await expect(focus).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.input-row input')).toBeEditable();
  expect((await (await request.get('/api/meeting')).json()).focus).toBe(true);
  await focus.click();
  await expect(focus).toHaveAttribute('aria-pressed','false');
});

test('retired unknown operations require confirming the old executor stopped before ending a wait',async({page},info)=>{
  const record={commandId:'retired-unknown-command',source:'wechat',accountId:'archived-account',peerId:'archived-peer',status:'unknown',createdAt:'2026-01-01T00:00:00Z',deliveryStatus:'unknown'};
  let records:typeof record[]=[];
  const closedBodies:unknown[]=[];
  const retiredProviderRequests:string[]=[];
  await page.route('**/api/social/accounts/retired/records',route=>route.fulfill({json:{records}}));
  await page.route('**/api/social/accounts/retired/end-wait',async route=>{
    closedBodies.push(route.request().postDataJSON());
    if(closedBodies.length===1){await route.fulfill({status:409,json:{detail:'Old executor remains active'}});return;}
    if(closedBodies.length===2){await route.fulfill({json:{ok:true,records:null}});return;}
    records=[];
    await route.fulfill({json:{ok:true,records,attention:{activation:'dormant',focus:false,phonePaused:false,busy:false,activity:null,presentation:null}}});
  });
  await page.route('**/api/social/accounts/wechat/**',route=>{retiredProviderRequests.push(route.request().url());return route.abort();});
  await openExtensionTab(page,'插件');
  const archive=page.locator('.social-retired-records');
  await expect(archive).toHaveCount(0);
  records=[record];
  await page.reload();
  await openExtensionTab(page,'插件');
  await expect(archive).toBeVisible();
  await archive.locator('summary').click();
  await expect(archive.getByText('archived-account',{exact:true})).toBeVisible();
  await expect(archive.getByText('archived-peer',{exact:true})).toBeVisible();
  await expect(archive.getByText('retired-unknown-command',{exact:true})).toBeVisible();
  await expect(archive.getByText('消息是否发出仍未知。结束等待只解除旧操作的等待，不会重发消息，也不会恢复微信。')).toBeVisible();
  const endWait=archive.getByRole('button',{name:'结束等待',exact:true});
  await expect(endWait).toBeDisabled();
  expect(closedBodies).toEqual([]);
  await archive.getByRole('checkbox',{name:'我已停止旧微信桥接及其执行进程，并确认它不会继续发送。'}).check();
  await page.screenshot({path:info.outputPath('retired-operation-confirmation.png')});
  await endWait.click();
  await expect(archive.getByRole('alert')).toBeVisible();
  await expect(archive.getByText('retired-unknown-command',{exact:true})).toBeVisible();
  expect(closedBodies).toEqual([{commandId:'retired-unknown-command',executorStopped:true}]);
  await endWait.click();
  await expect.poll(()=>closedBodies.length).toBe(2);
  await expect(archive.getByRole('alert')).toBeVisible();
  await expect(archive.getByText('retired-unknown-command',{exact:true})).toBeVisible();
  await endWait.click();
  await expect(archive).toHaveCount(0);
  expect(closedBodies).toEqual([{commandId:'retired-unknown-command',executorStopped:true},{commandId:'retired-unknown-command',executorStopped:true},{commandId:'retired-unknown-command',executorStopped:true}]);
  expect(retiredProviderRequests).toEqual([]);
  await expect(page.locator('.official-plugins .social-card')).toHaveCount(1);
});
