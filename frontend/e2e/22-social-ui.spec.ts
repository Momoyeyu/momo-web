import {test,expect} from './fixtures';
import {bootChat,openTab,waitForChatReady} from './helpers';

test('cold routes stay dormant until Boot, including settings and a direct chat URL',async({page,request})=>{
  await page.goto('/#/chat');
  await expect(page.locator('.title-screen')).toBeVisible();
  expect((await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
  await openTab(page,'拓展');
  await expect(page.locator('.official-plugins .social-card')).toHaveCount(2);
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

test('QQ and WeChat account panels keep separate drafts and enforce an empty allowlist',async({page,request},info)=>{
  const accountsResponse=await request.get('/api/social/accounts');
  expect(accountsResponse.ok(),await accountsResponse.text()).toBe(true);
  const original=(await accountsResponse.json()).accounts as Array<{provider:string;allowlistEnabled:boolean;allowlist:Array<{peerId:string}>}>;
  expect(original.map(account=>account.provider)).toEqual(['qq','wechat']);
  expect(original.every(account=>account.allowlistEnabled===false)).toBe(true);
  try{
    await openTab(page,'拓展');
    const cards=page.locator('.official-plugins .social-card');
    await expect(cards).toHaveCount(2);
    await cards.first().getByRole('button',{name:'配置'}).click();
    const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('input[type="password"]')).toHaveCount(1);
    await page.screenshot({path:info.outputPath('qq-account.png')});
    await dialog.locator('details.social-disclosure').first().locator('summary').click();
    await dialog.locator('input[type="password"]').fill('e2e-write-only-credential');
    await dialog.getByRole('tab',{name:'权限'}).click();
    await page.mouse.move(20,20);
    await page.waitForTimeout(450); // Let the horizontal tab transition finish for visual evidence.
    await page.screenshot({path:info.outputPath('qq-permissions.png')});
    await expect(dialog.getByRole('switch',{name:'主动私信'})).toBeDisabled();
    const policy=dialog.locator('.social-allowlist');
    await expect(policy.getByRole('switch')).toHaveAttribute('aria-checked','false');
    await policy.getByRole('switch').click();
    await expect(dialog.getByText('白名单为空，所有联系人均暂停处理。')).toBeVisible();
    await dialog.getByRole('button',{name:'保存',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    const saved=(await (await request.get('/api/social/accounts')).json()).accounts;
    expect(saved.find((item:{provider:string})=>item.provider==='qq').allowlistEnabled).toBe(true);
    expect(saved.find((item:{provider:string})=>item.provider==='qq').allowlist).toEqual([]);
    expect(saved.find((item:{provider:string})=>item.provider==='qq').hasCredential).toBe(true);
    expect(saved.find((item:{provider:string})=>item.provider==='wechat').allowlistEnabled).toBe(original.find(item=>item.provider==='wechat')?.allowlistEnabled);
    expect(JSON.stringify(saved)).not.toMatch(/"token"\s*:/);
    expect(JSON.stringify(saved)).not.toContain('e2e-write-only-credential');
    await cards.last().getByRole('button',{name:'配置'}).click();
    await expect(page.getByRole('dialog',{name:'微信 账号设置'})).toBeVisible();
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
