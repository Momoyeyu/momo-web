import {expect, type Page} from './fixtures';
import {openTab} from './helpers';

export async function mockEnabledMod(page: Page, name: 'QQ'|'Minecraft') {
  const capability = name.toLowerCase();
  const mod = {id:'momo.' + capability, name, version:'1.0.0', kind:'integration', source:'official',
    platforms:['darwin-arm64'], enabled:true, capabilities:[capability], resources:[]};
  await page.route(/\/api\/mods$/, route => route.fulfill({json:{mods:[mod]}}));
}

export async function openModLibrary(page: Page) {
  const library = page.getByRole('dialog', {name:'模组库',exact:true});
  if (!await library.isVisible()) {
    await openTab(page,'模组');
    await page.locator('#config-mods').getByRole('button',{name:'管理',exact:true}).click();
  }
  await expect(library).toBeVisible();
  return library;
}

export async function openModManager(page: Page, name: 'QQ'|'Minecraft') {
  const dialog = page.getByRole('dialog', {name, exact:true});
  if (!await dialog.isVisible()) {
    const library=await openModLibrary(page);
    const row = library.locator('.opt-row').filter({has:page.getByText(name, {exact:true})});
    await row.getByRole('button', {name:'配置 '+name, exact:true}).click();
  }
  await expect(dialog.getByRole('button', {name:'停用模组', exact:true})).toBeVisible();
  return dialog;
}
