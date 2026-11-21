import {test, expect} from './fixtures';
import {openApp} from './helpers';

test('title menu hints are plain text', async ({page}) => {
  await openApp(page);
  const hints = page.locator('.title-menu .mi-hint');
  await expect(hints).toHaveText(['boot', 'config']);
  for (const hint of await hints.all()) {
    await expect(hint).toHaveCSS('border-top-width', '0px');
    await expect(hint).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(hint).toHaveCSS('text-transform', 'uppercase');
  }
});

test('uninstall confirmation leaves room below its footer divider', async ({page}) => {
  await page.route(/\/api\/mods$/, route => route.fulfill({json:{
    mods:[{id:'demo.content', name:'Fixture mod', enabled:false, resources:[]}],
  }}));
  await openApp(page, 'settings');
  await page.locator('#config-customize').getByRole('button',{name:'管理模组',exact:true}).click();
  const library = page.getByRole('dialog',{name:'模组库',exact:true});
  await library.getByRole('button',{name:'卸载 Fixture mod',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Fixture mod',exact:true});
  await expect(dialog.locator('.mod-dialog-heading').getByRole('button',{name:'返回'})).toBeVisible();
  const footer = dialog.locator('.modal-foot');
  const action = footer.getByRole('button',{name:'卸载模组'});
  await expect(action).toBeVisible();
  await expect(footer).toHaveCSS('border-top-width', '1px');
  expect(await action.evaluate(button =>
    button.getBoundingClientRect().top - button.parentElement!.getBoundingClientRect().top,
  )).toBeGreaterThanOrEqual(12);
});

for (const width of [640, 960, 1280]) {
  test(`settings action icons align in three languages at ${width}px`, async ({page, request}) => {
    const state = await (await request.get('/api/state')).json();
    await page.setViewportSize({width, height: width * 9 / 16});
    await page.route('**/api/state', route => route.fulfill({json: state}));
    await page.route('**/api/intro', route => route.fulfill({json: {phase: 'completed', configurationValid: true}}));
    await page.route('**/api/mods', route => route.fulfill({
      json: {mods: [{id: 'momo.qq', name: 'QQ', enabled: false, resources: []}]},
    }));

    for (const lang of ['zh', 'en', 'ja']) {
      state.settings.general.lang = lang;
      await page.goto('/#/settings');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', lang === 'zh' ? 'zh-CN' : lang);
      await expect(page.locator('.config-index button')).toHaveCount(7, {timeout: 2000});
      const customize = page.locator('#config-customize');
      await expect(customize.getByRole('heading', {level: 2})).toHaveText(
        {zh:'定制',en:'Customize',ja:'カスタム'}[lang]!,
      );
      const library = customize.locator('.customize-library');
      await expect(library.getByRole('button')).toHaveCount(2);
      const [avatar, manageMods] = await library.getByRole('button').all();
      await expect(library).not.toContainText(/QQ|Minecraft/);
      for (const button of [avatar, manageMods]) {
        await expect(button).toHaveText('');
        await expect(button).toHaveAccessibleName(/\S/);
        await expect(button).toHaveAttribute('data-tip', /\S/);
        await expect(button.locator('svg')).toBeVisible();
      }
      const dialogue = page.locator('#config-dialogue > .config-card');
      const switches = dialogue.locator('.dialogue-switches').getByRole('switch');
      await expect(switches).toHaveCount(2);
      const [statusToggle, proactiveToggle] = await Promise.all(
        (await switches.all()).map(toggle => toggle.boundingBox()),
      );
      if (width >= 960) {
        expect(statusToggle!.y).toBeCloseTo(proactiveToggle!.y, 0);
        expect(statusToggle!.x + statusToggle!.width).toBeLessThan(proactiveToggle!.x);
      } else {
        expect(statusToggle!.x).toBeCloseTo(proactiveToggle!.x, 0);
        expect(statusToggle!.y + statusToggle!.height).toBeLessThan(proactiveToggle!.y);
      }
      await expect(dialogue.locator('.config-preview')).toBeVisible();
      await expect(dialogue.getByRole('button')).toHaveCount(0);
      const avatarBox = (await avatar.boundingBox())!;
      const modBox = (await manageMods.boundingBox())!;
      const mcp = customize.locator('.mcp-heading');
      const addBox = (await mcp.getByRole('button').boundingBox())!;
      expect(avatarBox.x).toBeCloseTo(modBox.x, 0);
      expect(avatarBox.width).toBeCloseTo(modBox.width, 0);
      expect(avatarBox.width).toBeCloseTo(addBox.width, 0);
      expect(avatarBox.height).toBeCloseTo(addBox.height, 0);
      if (width >= 960) {
        expect(avatarBox.y).toBeCloseTo(addBox.y, 0);
        expect(avatarBox.x + avatarBox.width).toBeLessThan(addBox.x);
      } else {
        expect(avatarBox.x).toBeCloseTo(addBox.x, 0);
        expect(modBox.y + modBox.height).toBeLessThan(addBox.y);
      }
      await page.evaluate(() => document.fonts.ready);
      const languageFields = page.locator('#config-language .sel-face');
      await expect(languageFields).toHaveCount(2);
      const interfaceLanguage = (await languageFields.nth(0).boundingBox())!;
      const chatLanguage = (await languageFields.nth(1).boundingBox())!;
      expect(interfaceLanguage).not.toBeNull();
      expect(chatLanguage).not.toBeNull();
      expect(interfaceLanguage.x + interfaceLanguage.width).toBeLessThan(chatLanguage.x);
      expect(interfaceLanguage.y).toBeCloseTo(chatLanguage.y, 0);
      expect(interfaceLanguage.width).toBeCloseTo(chatLanguage.width, 0);
      expect(interfaceLanguage.width).toBeLessThanOrEqual(144);

      const operations = page.locator('#config-operations');
      await expect(operations.getByRole('switch')).toHaveCount(2);
      await expect(operations.locator('.sel-face')).toHaveCount(0);

      const dataRows = page.locator('#config-data > .config-card > .opt-row');
      await expect(dataRows).toHaveCount(2);
      const transferActions = dataRows.last().getByRole('button');
      await expect(transferActions).toHaveCount(2);
      const [exportTip, importTip] = {zh:['导出','导入'],en:['Export','Import'],ja:['書き出し','読み込み']}[lang]!;
      await expect(transferActions.first()).toHaveAttribute('data-tip', exportTip);
      await expect(transferActions.last()).toHaveAttribute('data-tip', importTip);
      const [exportBox, importBox] = await Promise.all(
        (await transferActions.all()).map(action => action.boundingBox()),
      );
      expect(exportBox!.y).toBeCloseTo(importBox!.y, 0);
      expect(exportBox!.x + exportBox!.width).toBeLessThan(importBox!.x);

      const actions = page.locator([
        '#config-models .config-model-row > button',
        '#config-data .opt-ctl > button',
        '#config-operations .opt-ctl > .icon-btn',
        '#config-sound .opt-ctl > button:not(.sel-face, [role="switch"])',
      ].join(', '));
      await expect(actions).toHaveCount(12);
      expect(await actions.evaluateAll(buttons => buttons.filter(button => {
        const bounds = button.getBoundingClientRect();
        const row = button.closest('.opt-row, .config-model-row')!.getBoundingClientRect();
        const label = button.getAttribute('aria-label');
        const leadsGroup = button.nextElementSibling?.matches('button');
        return bounds.width !== 34 || bounds.height !== 34
          || (leadsGroup ? bounds.right > row.right : Math.abs(bounds.right - row.right) > 1)
          || button.textContent !== '' || !button.querySelector('svg')
          || !label || !button.getAttribute('data-tip');
      }).map(button => button.getAttribute('aria-label'))), `${lang} at ${width}px`).toEqual([]);
      expect(await page.locator('.config-scroll').evaluate(el=>el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
  });
}
