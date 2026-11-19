import {expect, type Page} from './fixtures';
import {openTab} from './helpers';

export async function mockEnabledMod(page: Page, name: 'QQ'|'Minecraft') {
  const capability = name.toLowerCase();
  const mod = {id:'momo.' + capability, name, version:'1.0.0', kind:'integration', source:'official',
    platforms:['darwin-arm64'], enabled:true, capabilities:[capability], resources:[]};
  await page.route(/\/api\/mods$/, route => route.fulfill({json:{mods:[mod]}}));
}

export async function openModManager(page: Page, name: 'QQ'|'Minecraft') {
  const dialog = page.getByRole('dialog', {name, exact:true});
  if (!await dialog.isVisible()) {
    await openTab(page, '模组');
    const row = page.locator('#config-mods .opt-row').filter({has:page.getByText(name, {exact:true})});
    await row.getByRole('button', {name:'配置模组', exact:true}).click();
  }
  await expect(dialog.getByRole('button', {name:'停用模组', exact:true})).toBeVisible();
  return dialog;
}
