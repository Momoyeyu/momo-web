import {mockEnabledMod,openModManager} from './mod-fixtures';
import {test,expect} from './fixtures';
import {bootChat,waitForChatReady} from './helpers';
test.beforeEach(async ({page}) => { await mockEnabledMod(page,'Minecraft'); });

test('chat offers independent game control beside the scene, with reachable pause and stop',async({page},info)=>{
 let active=false,paused=false;let attached:Record<string,unknown>|null=null;const actions:string[]=[];
 await page.setViewportSize({width:1600,height:900});
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:false,browser:false,minecraft:true}}}));
 await page.route('**/api/minecraft/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/sessions')){await r.fulfill({json:{sessions:[{id:'fixture',pid:42,world:'local/test',account:'owner',playerName:'momo-test',ready:true}]}});return;}
  if(path.endsWith('/attach')){attached=r.request().postDataJSON();active=true;}
  if(path.endsWith('/tasks')){const action=r.request().postDataJSON().action;actions.push(action);paused=action==='pause';}
  if(path.endsWith('/stop'))active=false;
  await r.fulfill({json:{active,sessionId:active?'fixture':null,generation:17,permissions:active?['game.observe','game.chat','game.move','game.modify']:[],paused,autonomous:false,decisionNeeded:false,tasks:[],goal:null}});
 });
 await bootChat(page);
 const trigger=page.getByRole('button',{name:'Minecraft 陪玩',exact:true});await trigger.click();
 const panel=page.locator('#chat-game-activity');await expect(panel).toBeVisible();
 await expect(page.locator('.modal-overlay')).toHaveCount(0);
 const box=(await panel.boundingBox())!,stage=(await page.locator('.app-stage').boundingBox())!;
 expect(box.x).toBeGreaterThan(stage.x+stage.width/2);expect(box.y).toBeGreaterThanOrEqual(stage.y);
 expect(box.y+box.height).toBeLessThanOrEqual(stage.y+stage.height);
 await panel.locator('.sel-face').click();await panel.getByRole('option',{name:'momo-test · local/test'}).click();
 const permit=panel.getByRole('switch',{name:'操控角色与世界交互'});
 const originallyPermitted=await permit.getAttribute('aria-checked')==='true';
 if(!originallyPermitted)await permit.click();
 await panel.getByRole('button',{name:'启动陪玩'}).click();
 await expect.poll(()=>attached).toMatchObject({sessionId:'fixture',permissions:['game.observe','game.chat','game.move','game.modify']});
 await expect(panel.getByRole('button',{name:'启动陪玩'})).toHaveCount(0);await expect(permit).toHaveCount(0);
 await panel.getByRole('button',{name:'暂停游玩'}).click();await expect.poll(()=>actions).toEqual(['pause']);
 await panel.getByRole('button',{name:'继续游玩'}).click();await expect.poll(()=>actions).toEqual(['pause','resume']);
 await page.screenshot({path:info.outputPath('game-entry-wide.png')});
 await page.setViewportSize({width:800,height:450});
 await expect.poll(async()=>{const a=await panel.boundingBox(),b=await page.locator('.app-stage').boundingBox();return !!a&&!!b&&a.x>=b.x+b.width/2&&a.y>=b.y&&a.y+a.height<=b.y+b.height+1;}).toBe(true);
 await panel.getByRole('button',{name:'停止陪玩'}).scrollIntoViewIfNeeded();await panel.getByRole('button',{name:'停止陪玩'}).click();
 await expect.poll(()=>active).toBe(false);await expect(panel.getByText('已停止',{exact:true})).toBeVisible();await page.screenshot({path:info.outputPath('game-entry-compact.png')});
 if(!originallyPermitted)await permit.click();
 await expect.poll(async()=>Boolean((await (await page.request.get('/api/state')).json()).settings.general.minecraftPlay)).toBe(originallyPermitted);
 await panel.getByRole('button',{name:'关闭',exact:true}).click();await expect(panel).toHaveCount(0);
});
test('an active game stays attached across closing the panel and returning from settings',async({page})=>{
 let stops=0;
 await page.route('**/api/extensions/activities',route=>route.fulfill({json:{enabled:{computer:false,browser:false,minecraft:true}}}));
 await page.route('**/api/minecraft/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/sessions')){
   await route.fulfill({json:{sessions:[{id:'running',pid:42,world:'local/test',account:'owner',playerName:'momo-test',ready:true}]}});
   return;
  }
  if(path.endsWith('/stop'))stops++;
  await route.fulfill({json:{active:true,sessionId:'running',generation:17,permissions:['game.observe'],tasks:[]}});
 });
 await bootChat(page);
 const trigger=page.getByRole('button',{name:'Minecraft 陪玩',exact:true});
 const panel=page.locator('#chat-game-activity');
 await trigger.click();
 await expect(panel.getByText('momo-test · local/test',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(panel).toHaveCount(0);
 await expect(trigger).toBeFocused();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await expect(page.locator('.settings-page')).toBeVisible();
 await page.getByRole('button',{name:'返回对话',exact:true}).click();
 await waitForChatReady(page);
 await trigger.click();
 await expect(panel.getByText('momo-test · local/test',{exact:true})).toBeVisible();
 expect(stops).toBe(0);
});

test('Minecraft attaches existing world without launcher or login',async({page})=>{
 let active=false;let attached:Record<string,unknown>|null=null;
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:true,browser:true,minecraft:true}}}));
 await page.route('**/api/minecraft/**',async r=>{
 const path=new URL(r.request().url()).pathname;
 if(path.endsWith('/sessions')){await r.fulfill({json:{sessions:[{id:'fixture',pid:42,world:'local/minecraft:overworld',account:'owner',playerName:'momo-test',ready:true}]}});return;}
 if(path.endsWith('/attach')){attached=r.request().postDataJSON();active=true;}
 if(path.endsWith('/stop'))active=false;
 await r.fulfill({json:{active,generation:17,permissions:[],paused:false,autonomous:false,decisionNeeded:false,tasks:[],goal:null}});
 });
 await bootChat(page);await openModManager(page,'Minecraft');
 const gameCard=page.locator('.extension-card').filter({hasText:'Minecraft 陪玩'});
 await expect(gameCard.getByRole('switch')).toHaveCount(0);
 await gameCard.getByRole('button',{name:'配置',exact:true}).click();
 const modal=page.getByRole('dialog',{name:'Minecraft 陪玩',exact:true});
 await expect(modal.getByText('微软公共客户端 ID',{exact:true})).toHaveCount(0);
 await modal.locator('.sel-face').click();await modal.getByRole('option',{name:'momo-test · local/minecraft:overworld'}).click();
 const gameplay=modal.getByRole('switch',{name:'操控角色与世界交互'});
 if(await gameplay.getAttribute('aria-checked')!=='true')await gameplay.click();
 await modal.getByRole('button',{name:'启动陪玩'}).click();
 await expect.poll(()=>attached).toMatchObject({sessionId:'fixture',permissions:['game.observe','game.chat','game.move','game.modify']});
 await modal.getByRole('button',{name:'停止陪玩'}).click();
 await expect.poll(()=>active).toBe(false);
});

test('settings-owned gameplay requests subsequent decisions and discards unseen speech across reload',async({page})=>{
 let active=false,decisions=0;const discarded:Record<string,unknown>[]=[];
 await page.route('**/api/extensions/activities',r=>r.fulfill({json:{enabled:{computer:false,browser:false,minecraft:true}}}));
 await page.route('**/api/minecraft/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path.endsWith('/sessions')){await r.fulfill({json:{sessions:[{id:'fixture',pid:42,world:'local/minecraft:overworld',account:'owner',playerName:'momo-test',ready:true}]}});return;}
  if(path.endsWith('/attach'))active=true;
  if(path.endsWith('/stop'))active=false;
  await r.fulfill({json:{active,generation:17,permissions:['game.observe','game.chat','game.move','game.modify'],paused:false,autonomous:active,decisionNeeded:active,tasks:[],goal:null}});
 });
 await page.route('**/api/chat/minecraft-decision',async r=>{
  decisions++;const identity={runId:`game-${decisions}`,generation:17,presentationToken:`speech-${decisions}`};
  await r.fulfill({contentType:'text/event-stream',body:[{t:'sentence',no:0,text:'Invisible game commentary.',cues:[],at:'',...identity},{t:'done',...identity}].map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')});
 });
 await page.route('**/api/meeting/presentation',async r=>{
  const body=r.request().postDataJSON();if(body.outcome==='discarded')discarded.push(body);
  await r.fulfill({json:{activation:'active'}});
 });
 await bootChat(page);await openModManager(page,'Minecraft');
 const gameCard=page.locator('.extension-card').filter({hasText:'Minecraft 陪玩'});
 await expect(gameCard.getByRole('switch')).toHaveCount(0);
 await gameCard.getByRole('button',{name:'配置',exact:true}).click();
 const modal=page.getByRole('dialog',{name:'Minecraft 陪玩',exact:true});await modal.locator('.sel-face').click();
 await modal.getByRole('option',{name:'momo-test · local/minecraft:overworld'}).click();
 const gameplay=modal.getByRole('switch',{name:'操控角色与世界交互'});
 if(await gameplay.getAttribute('aria-checked')!=='true')await gameplay.click();
 await modal.getByRole('button',{name:'启动陪玩'}).click();
 await expect.poll(()=>discarded.length,{timeout:12000}).toBeGreaterThanOrEqual(2);
 expect(discarded.every(item=>item.text==='')).toBe(true);
 const prior=decisions;await page.reload();await expect(page.locator('.settings-page')).toBeVisible();
 await expect.poll(()=>decisions,{timeout:12000}).toBeGreaterThan(prior);
 await expect.poll(()=>discarded.length,{timeout:12000}).toBeGreaterThan(prior);
 expect(discarded.every(item=>item.text==='')).toBe(true);
});
