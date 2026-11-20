import {test,expect} from './fixtures';
import {openModLibrary} from './mod-fixtures';
import {fileURLToPath} from 'node:url';

const bundle=fileURLToPath(new URL('../../docs/examples/evening-chimes.momomod',import.meta.url));
test('local content mod installs disabled, serves audio only when enabled and can be removed',async({page,request})=>{
  const library=await openModLibrary(page);
  await library.getByRole('button',{name:'获取模组',exact:true}).click();
  await library.getByRole('button',{name:'导入文件',exact:true}).click();
  const importDialog=page.getByRole('dialog',{name:'导入文件',exact:true});
  const chooser=page.waitForEvent('filechooser');
  await importDialog.getByRole('button',{name:'导入文件'}).click();
  await (await chooser).setFiles(bundle);
  await expect(importDialog).toContainText('evening-chimes.momomod');
  await importDialog.getByRole('button',{name:'导入文件'}).click();
  await expect(library).toBeVisible();
  const mods=await (await request.get('/api/mods')).json();
  const pack=mods.mods.find((m:{resources:{type:string}[]})=>m.resources.some(r=>r.type==='bgm'));
  expect(pack.enabled).toBe(false);
  const dialog=page.getByRole('dialog',{name:pack.name,exact:true});
  const row=library.locator('.opt-row').filter({has:page.getByText(pack.name,{exact:true})});
  try {
    expect((await request.get(pack.resources[0].url)).ok()).toBe(false);
    await row.getByRole('button',{name:'配置模组'}).click();
    await dialog.getByRole('button',{name:'启用模组'}).click();
    await expect(dialog.getByRole('button',{name:'停用模组'})).toBeVisible();
    const file=await request.get(pack.resources[0].url);
    expect(file.ok()).toBe(true);
    expect((await file.body()).subarray(0,4).toString()).toBe('RIFF');
    await page.reload();
    await openModLibrary(page);
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked','true');
    await row.getByRole('button',{name:'配置模组'}).click();
    await dialog.getByRole('button',{name:'停用模组'}).click();
    await expect(dialog.getByRole('button',{name:'启用模组'})).toBeVisible();
    expect((await request.get(pack.resources[0].url)).ok()).toBe(false);
    await dialog.getByRole('button',{name:'卸载模组'}).click();
    await dialog.getByRole('button',{name:'卸载模组'}).click();
    await expect(row).toHaveCount(0);
  } finally {await request.delete('/api/mods/'+pack.id);}
});
