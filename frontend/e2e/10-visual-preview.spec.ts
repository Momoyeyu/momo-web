import { test, expect } from '@playwright/test';

for (const lang of ['zh', 'en', 'ja']) {
  test(`visual preview keeps aligned controls and local fonts (${lang})`, async ({ page, request }) => {
    const state = await (await request.get('/api/state')).json();
    state.settings.general = { ...state.settings.general, lang, chatLang: 'auto', voiceInput: false };
    await page.route('**/api/state', route => route.fulfill({ json: state }));
    await page.route('**/api/life/history**', route => route.fulfill({ json: { summary: '', messages: [] } }));
    const fontErrors: string[] = [];
    page.on('response', r => { if (r.url().includes('/fonts/') && !r.ok()) fontErrors.push(r.url()); });
    await page.goto('/#/chat');
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.dialog-box')).toHaveAttribute('lang', lang);
    const uiFont = await page.locator('.dialog-box').evaluate(el => getComputedStyle(el).fontFamily);
    expect(uiFont).toContain(lang === 'ja' ? 'Noto Sans JP' : 'Noto Sans SC');
    for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 600 }, { width: 800, height: 450 }]) {
      await page.setViewportSize(viewport);
      const dialog = await page.locator('.dialog-box').boundingBox();
      const toolbar = await page.locator('.chat-toolbar').boundingBox();
      expect(Math.abs(dialog!.x - toolbar!.x)).toBeLessThan(1);
      expect(Math.abs(dialog!.width - toolbar!.width)).toBeLessThan(1);
      const input = await page.locator('.input-row input').boundingBox();
      expect(input!.width).toBeGreaterThan(100);
      expect(input!.y + input!.height).toBeLessThanOrEqual(viewport.height);
    }
    expect(fontErrors).toEqual([]);
  });
}

test('resource editor supports custom checks, both lists, and keyboard close', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  state.settings.general = { ...state.settings.general, lang: 'zh', voiceInput: false };
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto('/#/settings');
  await page.getByRole('button', { name: '拓展', exact: true }).click();
  const card = page.locator('.avatar-row').first();
  await card.click();
  const dialog = page.getByRole('dialog', { name: /表情与动作/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.avatar-res-row')).toHaveCount(4);
  await dialog.getByRole('button', { name: /动作\s*10/ }).click();
  await expect(dialog.locator('.avatar-res-row')).toHaveCount(10);
  const checkbox = dialog.getByRole('checkbox').first();
  const before = await checkbox.isChecked();
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked({ checked: !before });
  await page.setViewportSize({ width: 800, height: 450 });
  const last = dialog.locator('.avatar-res-row').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});
