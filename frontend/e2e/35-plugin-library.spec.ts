import {test,expect} from './fixtures';
import {openExtensionTab} from './helpers';
test('plugin library searches, pages, and requires trust before enabling imported code',async({page},testInfo)=>{
 const plugins=Array.from({length:11},(_,i)=>({manifest:{id:`sample-${i}`,name:`Sample ${String(i).padStart(2,'0')}`,version:'1.0.0',description:'A long plugin description for layout validation.',capabilities:['screen.observe']},enabled:false}));
 let enabled=false;
 await page.route('**/api/extensions/plugins**',async route=>{
  if(route.request().method()==='PATCH'){enabled=true;await route.fulfill({json:{ok:true}});return;}
  await route.fulfill({json:{plugins}});
 });
 await openExtensionTab(page,'MCP');
 const library=page.locator('.plugin-library');
 await expect(library.getByRole('button',{name:'导入插件'})).toHaveCount(0);
 await library.getByRole('button',{name:'添加本地工具'}).click();
 const add=page.getByRole('dialog',{name:'添加本地工具'});
 await expect(add.getByRole('button',{name:'导入插件'})).toBeVisible();
 await add.getByRole('button',{name:'取消'}).click();
 await expect(library.locator('.mcp-row')).toHaveCount(4);
 await library.locator('.pager-btn').last().click();
 await expect(library.locator('.mcp-row')).toHaveCount(4);
 await page.screenshot({path:testInfo.outputPath('plugin-library.png')});
 await library.locator('.list-search').fill('Sample 10');
 await expect(library.locator('.mcp-row')).toHaveCount(1);
 await library.locator('.mcp-row button').first().click();
 await expect(page.getByRole('dialog',{name:'插件详情'})).toContainText('权限声明不是沙箱');
 expect(enabled).toBe(false);
 await page.getByRole('button',{name:'信任并启用'}).click();
 await expect.poll(()=>enabled).toBe(true);
});

test('a local package imports from the add dialog and can be uninstalled from its details', async ({page}) => {
  const manifest = {
    schemaVersion: 1, id: 'fixture-local-mcp', name: 'Local MCP fixture', version: '1.0.0',
    description: 'Local package installation fixture', entry: 'main.mjs', capabilities: [],
  };
  await openExtensionTab(page, 'MCP');
  const library = page.locator('.plugin-library');
  await library.getByRole('button', {name: '添加本地工具'}).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'local-mcp.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({manifest, files: {'main.mjs': 'export {};'}}))
  });
  await expect(dialog).toHaveCount(0);
  await library.getByRole('searchbox').fill(manifest.name);
  const row = library.locator('.mcp-row');
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await row.getByRole('button', {name: '插件详情'}).click();
  await expect(dialog).toContainText(manifest.description);
  await dialog.getByRole('button', {name: '卸载'}).click();
  await expect(dialog).toContainText('卸载此插件');
  await dialog.getByRole('button', {name: '卸载'}).click();
  await expect(row).toHaveCount(0);
});
