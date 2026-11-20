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

test('settings modal footer gives its action room below the divider', async ({page}) => {
  await openApp(page, 'settings');
  await page.locator('#config-mods').getByRole('button',{name:'管理',exact:true}).click();
  const library=page.getByRole('dialog',{name:'模组库',exact:true});
  await library.getByRole('button',{name:'获取模组',exact:true}).click();
  await library.getByRole('button',{name:'导入文件',exact:true}).click();
  await page.getByRole('dialog',{name:'导入文件',exact:true}).locator('input[type="file"]').setInputFiles({
    name: 'test.momomod',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('test'),
  });
  const dialog = page.getByRole('dialog').filter({has: page.locator('.extension-detail')});
  const footer = dialog.locator('.modal-foot');
  const action = footer.getByRole('button');
  await expect(action).toBeVisible();
  await expect(footer).toHaveCSS('border-top-width', '1px');
  expect(await action.evaluate(button =>
    button.getBoundingClientRect().top - button.parentElement!.getBoundingClientRect().top,
  )).toBeGreaterThanOrEqual(12);
});

for (const width of [640, 960, 1280]) {
  test(`settings action labels stay on one line in three languages at ${width}px`, async ({page, request}) => {
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
      await expect(page.locator('.config-index button')).toHaveCount(10);
      await expect(page.locator('#config-mods').getByRole('button')).toHaveCount(1);
      await expect(page.locator('#config-mods')).not.toContainText('QQ');
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


      const actions = await page.locator('.config-document .config-action').evaluateAll(buttons => buttons.map(button => {
        const range = document.createRange();
        range.selectNodeContents(button);
        const text = Array.from(range.getClientRects());
        const bounds = button.getBoundingClientRect();
        const row = button.closest('.opt-row');
        const group = button.closest('.config-card, .config-header');
        const positions = [row, group].filter(el => el !== null).map(el => el.getBoundingClientRect());
        return {
          label: button.textContent,
          paired: !!button.closest('.sound-pair'),
          width: bounds.width,
          height: bounds.height,
          lines: new Set(text.map(rect => Math.round(rect.top))).size,
          textFits: text.every(rect => rect.left >= bounds.left + 4 && rect.right <= bounds.right - 4),
          buttonFits: positions.every(rect => bounds.left >= rect.left - 1 && bounds.right <= rect.right + 1),
          columnRight: group ? Math.round(group.getBoundingClientRect().right - bounds.right) : null,
          group: group?.closest('section')?.id,
        };
      }));
      expect(actions.length).toBeGreaterThanOrEqual(12);
      expect(actions.filter(action => action.lines !== 1 || !action.textFits || !action.buttonFits),
        `${lang} at ${width}px`).toEqual([]);
      for (const action of actions) {
        if (width >= 960 && !action.paired) expect([action.width, action.height], `${lang} at ${width}px, ${action.label}`).toEqual([112, 34]);
      }
      const cardActions = actions.filter(action => action.group && action.columnRight !== null);
      expect(new Set(cardActions.map(action => action.columnRight)).size).toBeLessThanOrEqual(2);
      expect(await page.locator('.config-scroll').evaluate(el=>el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
  });
}
