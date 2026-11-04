import {test,expect} from './fixtures';
import {bootChat,openExtensionTab} from './helpers';
test('browser scope is explicit and page snapshots use the active grant',async({page},info)=>{
 let active=false;let hosts:string[]=[];const calls:Record<string,unknown>[]=[];
 await page.route('**/api/browser/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/start')){const body=route.request().postDataJSON();calls.push(body);hosts=body.allowedHosts;active=true;}
  if(path.endsWith('/stop'))active=false;
  if(path.endsWith('/open')){calls.push(route.request().postDataJSON());await route.fulfill({json:{data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII='}});return;}
  await route.fulfill({json:{active,generation:7,permissions:active?['observe']:[],allowedHosts:hosts}});
 });
 await bootChat(page);await openExtensionTab(page,'插件');
 await page.locator('.plugin-library-card').filter({has:page.getByText('浏览器',{exact:true})}).getByRole('button',{name:'配置',exact:true}).click();
 const modal=page.getByRole('dialog');
 await modal.getByRole('textbox',{name:'允许访问的网站'}).fill('https://example.com');
 await modal.getByRole('button',{name:'添加',exact:true}).click();
 await expect(modal.getByRole('alert')).toContainText('完整域名');
 await modal.getByRole('textbox',{name:'允许访问的网站'}).fill('example.com');
 await modal.getByRole('button',{name:'添加',exact:true}).click();
 await modal.getByRole('button',{name:'开启',exact:true}).click();
 await expect(modal.getByRole('textbox',{name:'网页地址'})).toBeVisible();
 expect(calls[0]).toMatchObject({allowedHosts:['example.com'],permissions:['observe']});
 await modal.getByRole('textbox',{name:'网页地址'}).fill('https://example.com/');
 await modal.getByRole('button',{name:'打开',exact:true}).click();
 await expect(modal.getByRole('img',{name:'隔离浏览器画面'})).toBeVisible();
 expect(calls[1]).toMatchObject({url:'https://example.com/',generation:7});
 await page.screenshot({path:info.outputPath('browser-settings.png')});
 await modal.getByRole('button',{name:'关闭',exact:true}).click();
 await expect(modal.getByRole('textbox',{name:'网页地址'})).toHaveCount(0);
});
