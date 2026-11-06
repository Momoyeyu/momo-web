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
 await r.fulfill({json:{active}});
 });
 await bootChat(page);await openExtensionTab(page,'插件');
 await page.locator('.extension-card').filter({hasText:'Minecraft 陪玩'}).getByRole('button',{name:'配置',exact:true}).click();
 const modal=page.getByRole('dialog');
 await expect(modal.getByText('微软公共客户端 ID',{exact:true})).toHaveCount(0);
 await modal.locator('.sel-face').click();await modal.getByRole('option',{name:'momo-test · local/minecraft:overworld'}).click();
 await modal.getByRole('switch',{name:'允许聊天'}).click();
 await modal.getByRole('button',{name:'启动陪玩'}).click();
 await expect.poll(()=>attached).toMatchObject({sessionId:'fixture',permissions:['game.observe','game.chat']});
 await modal.getByRole('button',{name:'停止陪玩'}).click();
 await expect.poll(()=>active).toBe(false);
});
