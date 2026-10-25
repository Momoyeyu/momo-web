import { test, expect } from './fixtures';
import JSZip from 'jszip';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { activeAvatar, presentation } from './helpers/runtime';

test.beforeEach(async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  state.avatarId = 'builtin';
  state.settings.general = { ...state.settings.general, lang: 'zh', voiceInput: false };
  // Preview and edits must never write the user's real configuration or history.
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/life/history**', route => route.fulfill({ json: { summary: '', messages: [] } }));
});

test('resource dialog owns the live canvas and returns it when closed', async ({ page }) => {
  await page.goto('/#/chat');
  await expect(page.getByRole('button', { name: '表演预览', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '全身', exact: true }).click();
  const originalCanvas = await page.locator('.live2d-home canvas').elementHandle();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '拓展', exact: true }).click();
  await page.locator('.avatar-row').first().click();
  const dialog = page.getByRole('dialog', { name: /表情与动作/ });
  const canvas = dialog.locator('canvas');
  await expect(canvas).toBeVisible();
  const happy = dialog.locator('[data-resource-id="happy"] .resource-play');
  await expect(happy).toBeEnabled();
  const enabled = dialog.locator('[data-resource-id="happy"] input[type=checkbox]');
  if (await enabled.isChecked()) await enabled.uncheck();
  await expect(happy).toBeEnabled();
  await happy.click();
  await expect(dialog.getByTestId('performance-face')).toContainText('happy');
  await dialog.getByRole('button', { name: /动作\s*10/ }).click();
  await expect(dialog.getByRole('button', { name: /^预览 / })).toHaveCount(10);
  await dialog.locator('[data-resource-id="motions/Hiyori_m04.motion3.json"] .resource-play').click();
  await expect(dialog.getByTestId('performance-face')).toContainText('中性');
  const progress = dialog.getByRole('progressbar', { name: '预览进度' });
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeLessThan(100);
  await expect(progress).toHaveAttribute('data-state', 'finished', { timeout: 10_000 });
  await expect(progress).toHaveAttribute('aria-valuenow', '100');
  const track = await progress.boundingBox(), viewport = await dialog.locator('.resource-preview-viewport').boundingBox();
  expect(track!.height).toBe(3);
  expect(Math.abs(track!.y + track!.height - viewport!.y - viewport!.height)).toBeLessThanOrEqual(1);
  await dialog.locator('[data-resource-id="motions/Hiyori_m04.motion3.json"] .resource-play').click();
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  await dialog.getByRole('button', { name: '恢复自然', exact: true }).click();
  await expect(progress).toHaveAttribute('data-state', 'idle');
  await expect(progress).toHaveAttribute('aria-valuenow', '0');
  const bounds = await canvas.boundingBox();
  const modal = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThan(modal!.x + modal!.width / 2);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('.live2d-home canvas')).toHaveCount(1);
  expect(await originalCanvas!.evaluate(node => node.parentElement?.classList.contains('live2d-home'))).toBe(true);
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(page.locator('.live2d-home canvas')).toBeVisible();
  await expect(page.locator('canvas.live2d-canvas')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '近景', exact: true })).toBeVisible();
});

test('previewing an imported model keeps the active avatar and restores it on close', async ({ page, request }) => {
  const zip = new JSZip();
  const root = fileURLToPath(new URL('../public/live2d/hiyori/', import.meta.url));
  async function add(dir: string, prefix = ''): Promise<void> {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (file.isDirectory()) await add(`${dir}/${file.name}`, `${prefix}${file.name}/`);
      else zip.file(`${prefix}${file.name}`, await readFile(`${dir}/${file.name}`));
    }
  }
  await add(root);
  // Leave most controls undeclared: import and rendering must discover the same files.
  const manifest = JSON.parse(await zip.file('Hiyori.model3.json')!.async('text'));
  delete manifest.FileReferences.Expressions;
  manifest.FileReferences.Motions = { Idle: [manifest.FileReferences.Motions.Idle[0]] };
  zip.file('Hiyori.model3.json', JSON.stringify(manifest));
  const encoded = await zip.generateAsync({ type: 'base64' });
  const state = await (await request.get('/api/state')).json();
  const builtin = state.avatars.find((avatar: { id: string }) => avatar.id === 'builtin');
  state.avatarId = 'builtin';
  state.settings.general = { ...state.settings.general, lang: 'zh', voiceInput: false };
  state.avatars.push({ ...builtin, id: 'preview-import', name: 'Preview imported', builtin: false, manifest: 'Hiyori.model3.json', fileName: 'preview.zip', size: 1, addedAt: '' });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto('/#/settings');
  await page.evaluate(async (data) => {
    const path = '/src/lib/idb.ts';
    const { putBlob } = await import(path);
    await putBlob('preview-import', await (await fetch(`data:application/zip;base64,${data}`)).blob());
  }, encoded);
  await page.getByRole('button', { name: '拓展', exact: true }).click();
  await page.locator('.avatar-row', { hasText: 'Preview imported' }).click();
  const dialog = page.getByRole('dialog', { name: /Preview imported/ });
  await expect(dialog.locator('[data-resource-id="happy"] .resource-play')).toBeEnabled();
  const ids = async () => ({ active: await activeAvatar(page), rendered: (await presentation(page, true))?.avatarId });
  await expect.poll(ids).toEqual({ active: 'builtin', rendered: 'preview-import' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect.poll(ids).toEqual({ active: 'builtin', rendered: 'builtin' });
  await page.locator('.avatar-row', { hasText: 'Preview imported' }).click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect.poll(ids).toEqual({ active: 'builtin', rendered: 'builtin' });
  await expect(page.locator('canvas.live2d-canvas')).toHaveCount(1);
});
