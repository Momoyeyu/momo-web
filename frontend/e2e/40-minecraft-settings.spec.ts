import {test,expect} from './fixtures';
import {bootChat,openExtensionTab} from './helpers';
test('managed Minecraft prepares resources, polls login and grants explicit scopes',async({page},info)=>{
 let prepared=false,authenticated=false,running=false;
 const starts:Record<string,unknown>[]=[];
 await page.route('**/api/minecraft/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/prepare'))prepared=true;
  if(path.endsWith('/begin')){await route.fulfill({json:{userCode:'TEST-1234',verificationUri:'https://www.microsoft.com/link',expiresIn:300}});return;}
  if(path.endsWith('/poll'))authenticated=true;
  if(path.endsWith('/start')){starts.push(route.request().postDataJSON());running=true;}
  if(path.endsWith('/stop'))running=false;
  if(path.endsWith('/logout'))authenticated=false;
  await route.fulfill({json:{prepared,authenticated,running,loginAvailable:true,...(authenticated?{profile:{name:'momo-test',id:'test'}}:{})}});
 });
 await bootChat(page);await openExtensionTab(page,'插件');
 await page.locator('.plugin-library-card').filter({has:page.getByText('Minecraft 陪玩',{exact:true})}).getByRole('button',{name:'配置',exact:true}).click();
 const modal=page.getByRole('dialog');
 await modal.getByRole('button',{name:'准备资源',exact:true}).click();
 await expect(modal.getByText('资源已校验',{exact:true})).toBeVisible();
 await modal.getByRole('textbox',{name:'微软公共客户端 ID',exact:true}).fill('00000000-0000-4000-8000-000000000001');
 await modal.getByRole('button',{name:'使用微软账号登录',exact:true}).click();
 await expect(modal.getByText('TEST-1234',{exact:true})).toBeVisible();
 await expect(modal.getByText('momo-test',{exact:true})).toBeVisible({timeout:10000});
 await modal.getByRole('textbox',{name:'允许的服务器（主机:端口）',exact:true}).fill('localhost:25565');
 await modal.getByRole('textbox',{name:'允许的世界标识',exact:true}).fill('minecraft:overworld');
 await modal.getByRole('switch',{name:'允许聊天',exact:true}).click();
 await page.screenshot({path:info.outputPath('minecraft-settings.png')});
 await modal.getByRole('button',{name:'启动陪玩',exact:true}).click();
 await expect(modal.getByRole('button',{name:'停止陪玩',exact:true})).toBeEnabled();
 expect(starts[0]).toMatchObject({server:'localhost:25565',world:'minecraft:overworld',permissions:['game.observe','game.chat']});
 await modal.getByRole('button',{name:'停止陪玩',exact:true}).click();
 await modal.getByRole('button',{name:'退出账号',exact:true}).click();
 await expect(modal.getByText('未登录',{exact:true})).toBeVisible();
});
