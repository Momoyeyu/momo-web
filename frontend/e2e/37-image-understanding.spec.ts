import {test,expect,type Page} from './fixtures';
import {bootChat,waitForChatReady} from './helpers';

async function paste(page:Page,count=1){
 await page.locator('.input-row input').evaluate((element,count)=>{
  const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='#f22';ctx.fillRect(0,0,120,80);
  const bytes=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!),c=>c.charCodeAt(0));
  const clipboardData=new DataTransfer();for(let i=0;i<count;i++)clipboardData.items.add(new File([bytes],`red-${i}.png`,{type:'image/png'}));
  element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
 },count);
}
for(const lang of ['zh','en','ja'])test(`native image input, removal, image-only send and history (${lang})`,async({page,request},info)=>{
 const original=await(await request.get('/api/state')).json();
 const state=structuredClone(original);state.settings.general.lang=lang;state.settings.general.voiceInput=false;state.settings.llm.vision=false;
 try{
  expect((await request.put('/api/state',{data:state})).ok()).toBeTruthy();
  const proof=await(await request.post('/api/vision/probe',{data:state.settings.llm})).json();expect(proof.ok).toBe(true);
  state.settings.llm.vision=true;expect((await request.put('/api/state',{data:state})).ok()).toBeTruthy();
  await page.setViewportSize({width:1440,height:900});await bootChat(page);
  await paste(page,4);await expect(page.locator('.image-draft')).toHaveCount(4);await expect(page.locator('.image-draft>small')).toHaveCount(0);
  await paste(page);await expect(page.locator('.image-draft-error')).toBeVisible();
  await page.locator('.image-draft>button').first().click();await expect(page.locator('.image-draft')).toHaveCount(3);
  for(const size of [{width:1440,height:900},{width:960,height:650},{width:800,height:450}]){
   await page.setViewportSize(size);
   const geometry=await page.evaluate(()=>{
    const r=(s:string)=>document.querySelector(s)!.getBoundingClientRect().toJSON();return {draft:r('.image-drafts'),row:r('.input-row'),subtitle:r('.subtitle'),box:r('.dialog-box'),rail:r('.chat-toolbar'),stage:r('.app-stage')};
   });
   expect(geometry.draft.y).toBeGreaterThanOrEqual(geometry.subtitle.bottom-1);
   expect(geometry.draft.bottom).toBeLessThanOrEqual(geometry.row.y+1);
   expect(geometry.box.right+12).toBeLessThan(geometry.rail.x);
   expect(geometry.box.bottom).toBeLessThanOrEqual(geometry.stage.bottom-12);
   await page.screenshot({path:info.outputPath(`images-${lang}-${size.width}.png`)});
  }
  // Pure-image send must work without inventing a text placeholder in history.
  await page.locator('.send-btn').click();await expect(page.locator('.image-drafts')).toHaveCount(0);
  await expect(page.locator('.terminal-output-text')).toContainText('red');
  await expect(page.locator('.chat-status')).toHaveClass(/status-idle/);
  await page.evaluate(()=>{location.hash='#/backlog';});await expect(page.locator('.backlog-page')).toBeVisible();
  await expect(page.locator('.bl-item.user').last().locator('.image-attachment')).toHaveCount(3);
  await page.locator('.bl-item.user').last().locator('button.image-attachment').first().click();
  await expect(page.locator('.image-lightbox')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('.image-lightbox')).toHaveCount(0);
  await page.screenshot({path:info.outputPath(`image-history-${lang}.png`)});
 }finally{await request.put('/api/state',{data:original});}
});

test('unsupported model stays disabled and failed send preserves draft',async({page,request})=>{
 const original=await(await request.get('/api/state')).json();
 try{
  const cfg={...original.settings.llm,vision:false,model:'no-vision'};
  expect((await(await request.post('/api/vision/probe',{data:cfg})).json()).ok).toBe(false);
  expect((await request.put('/api/state',{data:{...original,settings:{...original.settings,llm:{...cfg,vision:true}}}})).status()).toBe(400);
  const cfg2={...original.settings.llm,vision:false};expect((await(await request.post('/api/vision/probe',{data:cfg2})).json()).ok).toBe(true);
  await request.put('/api/state',{data:{...original,settings:{...original.settings,llm:{...cfg2,vision:true}}}});
  await bootChat(page);await paste(page);await expect(page.locator('.image-draft>small')).toHaveCount(0);
  await page.route('**/api/chat',route=>route.fulfill({status:503,json:{detail:'unavailable'}}));
  await page.locator('.input-row input').fill('Keep this draft');await page.locator('.send-btn').click();
  await expect(page.locator('.input-row input')).toHaveValue('Keep this draft');await expect(page.locator('.image-draft')).toHaveCount(1);
  await expect(page.locator('.send-btn')).toBeEnabled();
 }finally{await request.put('/api/state',{data:original});}
});

test('settings gates vision verification, resets on model edit, and stale upload cannot restore a removed draft',async({page,request},info)=>{
 const original=await(await request.get('/api/state')).json();
 try{
  const config=structuredClone(original);config.settings.llm={...config.settings.llm,model:'no-vision',vision:false};config.settings.general.lang='zh';
  await request.put('/api/state',{data:config});await page.goto('/#/settings');
  await page.locator('.stab',{hasText:'模型'}).click();
  const row=page.locator('.opt-row').filter({has:page.locator('.opt-label',{hasText:'识图'})});
  await expect(row.getByRole('switch')).toBeDisabled();
  await row.getByRole('button',{name:'验证识图能力'}).click();await expect(row.getByRole('switch')).toBeDisabled();
  await page.locator('[data-intro=llm] input').nth(2).fill('deterministic');
  await expect(row.getByRole('button',{name:'验证识图能力'})).toBeEnabled();
  await row.getByRole('button',{name:'验证识图能力'}).click();await expect(row.getByRole('switch')).toBeEnabled();
  await row.getByRole('switch').click();await expect(row.getByRole('switch')).toHaveAttribute('aria-checked','true');
  await page.screenshot({path:info.outputPath('vision-settings.png')});
  // A failed recheck must never pretend an enabled capability is off or trap it on.
  await page.route('**/api/vision/probe',route=>route.fulfill({status:503,json:{detail:'timeout'}}));
  await row.getByRole('button',{name:'验证识图能力'}).click();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked','true');
  await expect(row.getByRole('switch')).toBeEnabled();
  await row.getByRole('switch').click();await expect(row.getByRole('switch')).toHaveAttribute('aria-checked','false');
  await page.unroute('**/api/vision/probe');
  await page.locator('[data-intro=llm] input').nth(2).fill('other-model');await expect(row.getByRole('switch')).toBeDisabled();
  // Prepare the same proven fixture through the actual backend admission gate.
  config.settings.llm={...original.settings.llm,vision:true};await request.put('/api/state',{data:config});
  await page.reload();await page.evaluate(()=>{location.hash='#/title';});await bootChat(page);await waitForChatReady(page);
  let uploadFinished=false,uploadReady=false;
  await page.route('**/api/vision/images',async route=>{const response=await route.fetch();uploadReady=true;await new Promise(resolve=>setTimeout(resolve,300));await route.fulfill({response}).catch(()=>{});uploadFinished=true;});
  await paste(page);await expect(page.locator('.image-draft')).toHaveCount(1);
  await expect.poll(()=>uploadReady).toBe(true);
  await page.locator('.image-draft>button').first().click();await expect(page.locator('.image-draft')).toHaveCount(0);
  // Wait for the delayed upload's known completion, not for visual animation.
  await expect.poll(()=>uploadFinished).toBe(true);
  await expect(page.locator('.image-draft')).toHaveCount(0);
 }finally{await request.put('/api/state',{data:original});}
});


test('GIF drafts show the normalized first frame and mixed text sends intact',async({page,request})=>{
 const original=await(await request.get('/api/state')).json();
 try{
  const config=structuredClone(original);config.settings.llm.vision=false;config.settings.general.lang='zh';
  await request.put('/api/state',{data:config});expect((await(await request.post('/api/vision/probe',{data:config.settings.llm})).json()).ok).toBe(true);
  config.settings.llm.vision=true;await request.put('/api/state',{data:config});await bootChat(page);
  await page.locator('.input-row input').evaluate((el,encoded)=>{
   const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)),clipboardData=new DataTransfer();
   clipboardData.items.add(new File([bytes],'animation.gif',{type:'image/gif'}));
   el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}));
  },'R0lGODlhCgAKAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQABQAAACwAAAAACgAKAAAIEgABCBxIsKDBgwgTKlzIsGHCgAAh+QQBBQABACwAAAAACgAKAIEAAP8AAAAAAAAAAAAIEgABCBxIsKDBgwgTKlzIsGHCgAA7');
  await expect(page.locator('.image-draft>small')).toHaveText('静态帧');
  expect(await page.locator('.image-draft>img').evaluate(async el=>(await(await fetch((el as HTMLImageElement).src)).blob()).type)).toBe('image/jpeg');
  await page.locator('.input-row input').fill('Look at this image.');await page.locator('.send-btn').click();
  await expect(page.locator('.terminal-output-text')).toContainText('red');
  await expect(page.locator('.image-drafts')).toHaveCount(0);
 }finally{await request.put('/api/state',{data:original});}
});
