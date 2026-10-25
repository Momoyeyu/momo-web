import { expect, test, type Locator } from './fixtures';

async function insideStage(element: Locator) {
  const stage = await element.page().locator('.app-stage').boundingBox();
  const box = await element.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(stage!.x - 1);
  expect(box!.y).toBeGreaterThanOrEqual(stage!.y - 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(stage!.x + stage!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(stage!.y + stage!.height + 1);
}

test.beforeEach(async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  state.settings.general = { ...state.settings.general, lang: 'zh', voiceInput: false };
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/memories', route => route.fulfill({ json: [{ id: 'audit', content: '布局检查 '.repeat(50), pinned: true, createdAt: '2026-10-21T00:00:00Z' }] }));
  await page.goto('/#/settings');
});

test('explanatory tooltips stay inside the stage and dismiss on scroll', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 450 });
  await page.getByRole('button', { name: '模型', exact: true }).click();
  const pane = page.locator('.settings-pane:not([aria-hidden])');
  for (const hint of await pane.locator('.hint').all()) {
    await hint.scrollIntoViewIfNeeded();
    await hint.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await insideStage(tooltip);
    const tip = await tooltip.boundingBox(), trigger = await hint.boundingBox();
    expect(tip!.y + tip!.height <= trigger!.y || tip!.y >= trigger!.y + trigger!.height).toBeTruthy();
  }
  await pane.evaluate(el => el.dispatchEvent(new Event('scroll')));
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('settings overlays and resource controls remain reachable in a small window', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 450 });
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.locator('.mem-panel .list-item').first().click();
  await insideStage(page.getByRole('dialog'));
  await page.keyboard.press('Escape');
  await page.locator('.mem-panel .list-toolbar .icon-btn').click();
  await insideStage(page.getByRole('dialog'));
  await expect(page.getByRole('dialog').getByRole('button').last()).toBeInViewport();
  await page.keyboard.press('Escape');
  await page.locator('.mem-panel .list-item').first().getByRole('button', { name: '删除', exact: true }).click();
  await insideStage(page.getByRole('dialog'));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '拓展', exact: true }).click();
  await page.locator('.ext-panel .list-toolbar .icon-btn').click();
  await insideStage(page.getByRole('dialog'));
  await page.getByRole('button', { name: /从 JSON 填入/ }).click();
  await page.getByRole('dialog').locator('.sel-face').scrollIntoViewIfNeeded();
  await page.getByRole('dialog').locator('.sel-face').click();
  const modalBounds = await page.getByRole('dialog').boundingBox();
  const listBounds = await page.getByRole('listbox').boundingBox();
  expect(listBounds!.y + listBounds!.height).toBeLessThanOrEqual(modalBounds!.y + modalBounds!.height);
  await insideStage(page.getByRole('listbox'));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.settings-pane:not([aria-hidden]) .panel').first().locator('.list-toolbar .icon-btn').click();
  await insideStage(page.getByRole('dialog'));
  await page.keyboard.press('Escape');
  await page.locator('.avatar-row').first().click();
  const dialog = page.getByRole('dialog', { name: /表情与动作/ });
  await insideStage(dialog);
  await expect(dialog.locator('.avatar-res-row .icon-btn').first()).not.toHaveAttribute('data-tip');
  await dialog.locator('.avatar-res-row .icon-btn').first().hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await dialog.getByRole('button', { name: /动作\s*10/ }).click();
  await dialog.locator('.avatar-res-row').last().scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeInViewport();
});
