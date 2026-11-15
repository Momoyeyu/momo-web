import {test,expect} from './fixtures';
import {bootChat,openExtensionTab} from './helpers';
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
 await bootChat(page);await openExtensionTab(page,'插件');
 await page.locator('.extension-card').filter({hasText:'Minecraft 陪玩'}).getByRole('button',{name:'配置',exact:true}).click();
 const modal=page.getByRole('dialog');
 await expect(modal.getByText('微软公共客户端 ID',{exact:true})).toHaveCount(0);
 await modal.locator('.sel-face').click();await modal.getByRole('option',{name:'momo-test · local/minecraft:overworld'}).click();
 await modal.getByRole('switch',{name:'操控角色与世界交互'}).click();
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
 await bootChat(page);await openExtensionTab(page,'插件');
 await page.locator('.extension-card').filter({hasText:'Minecraft 陪玩'}).getByRole('button',{name:'配置',exact:true}).click();
 const modal=page.getByRole('dialog');await modal.locator('.sel-face').click();
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
