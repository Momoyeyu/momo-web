import {test,expect} from './fixtures';
import {openExtensionTab} from './helpers';

const keys=['receive','reply','proactive','contacts','history','media','friendRequests','groups','groupManagement'] as const;
const labels=['收取私聊','回复文字','主动私信','读取联系人','读取历史','附件与媒体','处理好友申请','群聊','群管理'];

test('QQ full permissions autosave explicit scopes and limits; explanations stay in Hint',async({page,request},info)=>{
  await page.setViewportSize({width:1440,height:1000});
  const initial=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  let account={...initial,permissions:Object.fromEntries(keys.map(key=>[key,key==='receive'||key==='reply'])),capabilities:Object.fromEntries(keys.map(key=>[key,true])),proactivePolicy:{recipientIds:[],maxPerHour:6,minIntervalSeconds:60,quietStart:22,quietEnd:8},groupAllowlist:[]};
  const writes:Record<string,any>[]=[];
  await page.route(/\/api\/social\/accounts$/,route=>route.fulfill({json:{accounts:[account],providers:[]}}));
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    const body=route.request().postDataJSON();writes.push(body);
    account={...account,...body,permissions:{...account.permissions,...body.permissions},proactivePolicy:{...account.proactivePolicy,...body.proactivePolicy}};
    await route.fulfill({json:account});
  });
  let mediaItems:{mediaId:string;name:string;mime:string;size:number}[]=[];let uploads=0;let removals=0;
  await page.route(/\/api\/social\/accounts\/qq\/media$/,async route=>{
    if(route.request().method()==='POST'){
      uploads++;expect(route.request().headers()['content-type']).toContain('multipart/form-data');
      expect(route.request().postDataBuffer()?.toString()).toContain('synthetic-note.txt');
      const item={mediaId:'synthetic-media',name:'synthetic-note.txt',mime:'text/plain',size:15};mediaItems=[item];await route.fulfill({json:item});
    }else await route.fulfill({json:{items:mediaItems}});
  });
  await page.route(/\/api\/social\/accounts\/qq\/media\/synthetic-media$/,async route=>{expect(route.request().method()).toBe('DELETE');removals++;mediaItems=[];await route.fulfill({json:{ok:true}});});
  await openExtensionTab(page,'插件');await page.locator('.official-plugins').getByRole('button',{name:'配置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  for(const label of labels)await expect(dialog.getByRole('switch',{name:label,exact:true})).toBeEnabled();
  await expect(dialog.locator('.social-unsupported')).toHaveCount(0);
  await dialog.getByRole('switch',{name:'仅与白名单聊天',exact:true}).click();
  await expect(dialog.getByText('输入后按回车或点添加；粘贴多个号码可用空格、逗号或换行分隔。',{exact:true})).toHaveCount(0);
  await expect(dialog.getByText('白名单为空，所有联系人均暂停处理。',{exact:true})).toHaveCount(0);
  await expect(dialog.locator('.social-scope-heading .hint')).toHaveAttribute('data-tip',/白名单为空/);
  await page.mouse.move(15,15);await page.waitForTimeout(450);
  await expect(dialog.getByRole('switch',{name:'仅与白名单聊天',exact:true})).toHaveAttribute('aria-checked','true');
  await page.screenshot({path:info.outputPath('qq-clean-permissions.png')});
  for(const label of ['主动私信','读取联系人','读取历史','附件与媒体','处理好友申请','群聊','群管理'])await dialog.getByRole('switch',{name:label,exact:true}).click();
  const proactive=dialog.getByRole('region',{name:'主动私信范围',exact:true});
  await proactive.getByRole('textbox',{name:'允许主动联系',exact:true}).fill('12345，23456');await proactive.getByRole('textbox',{name:'允许主动联系',exact:true}).press('Enter');
  await proactive.locator('.opt-row').filter({hasText:'每小时上限'}).getByRole('button').first().click();await proactive.getByRole('option',{name:'3 条 / 小时',exact:true}).click();
  await proactive.locator('.opt-row').filter({hasText:'最短间隔'}).getByRole('button').first().click();await proactive.getByRole('option',{name:'300 秒',exact:true}).click();
  await expect.poll(()=>account.proactivePolicy.recipientIds).toEqual(['12345','23456']);
  await expect.poll(()=>account.proactivePolicy.maxPerHour).toBe(3);await expect.poll(()=>account.proactivePolicy.minIntervalSeconds).toBe(300);
  const groups=dialog.getByRole('region',{name:'允许的群',exact:true});
  await groups.getByRole('textbox',{name:'添加群号',exact:true}).fill('34567');await groups.getByRole('textbox',{name:'添加群号',exact:true}).press('Enter');
  await expect.poll(()=>account.groupAllowlist).toEqual([{peerId:'34567'}]);
  await groups.getByRole('button',{name:'移除群号 34567',exact:true}).click();await expect.poll(()=>account.groupAllowlist).toEqual([]);
  const library=dialog.getByRole('region',{name:'可发送的附件',exact:true});
  await expect(library.getByRole('button',{name:'添加附件',exact:true})).toBeEnabled();
  await library.locator('input[type=file]').setInputFiles({name:'synthetic-note.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic hello')});
  await expect(library.getByText('synthetic-note.txt',{exact:true})).toBeVisible();expect(uploads).toBe(1);
  await library.getByRole('button',{name:'移除附件 synthetic-note.txt',exact:true}).click();await expect(library.getByText('synthetic-note.txt',{exact:true})).toHaveCount(0);expect(removals).toBe(1);
  await expect.poll(()=>Object.values(account.permissions).every(Boolean)).toBe(true);
  await groups.getByRole('textbox',{name:'添加群号',exact:true}).fill('45678');await groups.getByRole('textbox',{name:'添加群号',exact:true}).press('Enter');
  await expect.poll(()=>account.groupAllowlist).toEqual([{peerId:'45678'}]);
  await expect(dialog.locator('.social-save-state')).toContainText('已保存');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.locator('.official-plugins').getByRole('button',{name:'配置',exact:true}).click();
  await dialog.getByRole('tab',{name:'权限',exact:true}).click();
  await expect(proactive.getByRole('listitem')).toHaveCount(2);
  await expect(proactive.locator('.opt-row').filter({hasText:'每小时上限'}).getByRole('button').first()).toContainText('3 条 / 小时');
  await expect(proactive.locator('.opt-row').filter({hasText:'最短间隔'}).getByRole('button').first()).toContainText('300 秒');
  await expect(groups.getByText('45678',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  expect(writes.length).toBeGreaterThan(0);
  for(const write of writes){expect(write).not.toHaveProperty('enabled');expect(write).not.toHaveProperty('expectedSelfId');}
});

test('attachment library waits for the actual saved grant before its first authorized read',async({page,request})=>{
  const saved=(await (await request.get('/api/social/accounts')).json()).accounts[0];
  const configured=await request.put('/api/social/accounts/qq',{data:{enabled:false,expectedSelfId:'123456',permissions:{media:false}}});
  expect(configured.ok(),await configured.text()).toBe(true);
  const denied=await request.get('/api/social/accounts/qq/media');expect(denied.status()).toBe(403);
  let release:(()=>void)|undefined;let pendingSave=false;let mediaReads=0;
  await page.route(/\/api\/social\/accounts\/qq$/,async route=>{
    if(route.request().method()==='PUT'&&route.request().postDataJSON()?.permissions?.media===true){
      pendingSave=true;await new Promise<void>(resolve=>{release=resolve;});
    }
    await route.continue();
  });
  await page.route(/\/api\/social\/accounts\/qq\/media$/,async route=>{if(route.request().method()==='GET')mediaReads++;await route.continue();});
  try{
    await openExtensionTab(page,'插件');await page.locator('.official-plugins').getByRole('button',{name:'配置',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});await dialog.getByRole('tab',{name:'权限',exact:true}).click();
    await dialog.getByRole('switch',{name:'附件与媒体',exact:true}).click();
    await expect.poll(()=>pendingSave).toBe(true);
    await expect(dialog.getByRole('switch',{name:'附件与媒体',exact:true})).toHaveAttribute('aria-checked','true');
    expect(mediaReads).toBe(0);
    await expect(dialog.getByRole('region',{name:'可发送的附件',exact:true})).toHaveCount(0);
    release!();
    const library=dialog.getByRole('region',{name:'可发送的附件',exact:true});
    await expect(library.getByRole('button',{name:'添加附件',exact:true})).toBeEnabled();
    await expect(library.getByRole('alert')).toHaveCount(0);expect(mediaReads).toBe(1);
    await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  }finally{
    release?.();
    await request.put('/api/social/accounts/qq',{data:{enabled:false,expectedSelfId:saved.expectedSelfId,permissions:{media:saved.permissions.media}}});
  }
});

test('operation records show concise action labels while old and unknown actions retain peer fallback',async({page})=>{
  await page.route(/\/api\/social\/accounts\/qq\/records$/,route=>route.fulfill({json:{records:[
    {commandId:'read-contacts-command',action:'contacts.list',status:'completed'},
    {commandId:'group-command',action:'groups.manage',peerId:'group:12345',status:'completed'},
    {commandId:'old-command',peerId:'67890',status:'completed'},
    {commandId:'future-command',action:'future.technical.action',peerId:'98765',status:'completed'},
  ]}}));
  await openExtensionTab(page,'插件');await page.locator('.official-plugins').getByRole('button',{name:'配置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'QQ 账号设置'});await dialog.getByRole('tab',{name:'记录',exact:true}).click();
  const records=dialog.locator('.social-record');await expect(records).toHaveCount(4);
  await expect(records.nth(0).locator('.social-record-top strong')).toHaveText('读取联系人');
  await expect(records.nth(1).locator('.social-record-top strong')).toHaveText('群管理 · group:12345');
  await expect(records.nth(2).locator('.social-record-top strong')).toHaveText('67890');
  await expect(records.nth(3).locator('.social-record-top strong')).toHaveText('98765');
  await expect(dialog.getByText('future.technical.action',{exact:true})).toHaveCount(0);
});
