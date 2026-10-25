import { test, expect } from "@playwright/test";
import { presentation } from './helpers/runtime';
import {waitForChatReady} from './helpers';

// Intercept configuration/chat only; exercise the real vendored model and renderer.
// All writes are intercepted so the user's settings, memory and conversation stay intact.
test.beforeEach(async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  state.avatarId = 'builtin';
  state.settings.general = { ...state.settings.general, lang: "zh", voiceInput: false, textSpeed: 25, sentenceSpeed: 100 };
  state.settings.llm = { url: 'http://preview.test', model: 'preview', key: '' };
  state.settings.tts = { url: '', key: '', voice: '', prompt: '' };
  await page.route('**/api/state', (route) => route.fulfill({ json: state }));
  await page.route('**/api/chat/interrupt', (route) => route.fulfill({ status: 204 }));
  await page.route('**/api/asr/**', (route) => route.fulfill({ json: { ready: false, missing: [] } }));
});

async function face(page: import('@playwright/test').Page): Promise<string | null> {
  return (await presentation(page))?.expressionState.name ?? null;
}

test('default model previews all four expressions inside its resource editor', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByRole('button', { name: '拓展', exact: true }).click();
  await page.locator('.avatar-row').first().click();
  const dialog = page.getByRole('dialog', { name: /表情与动作/ });
  for (const name of ['happy', 'curious', 'surprised', 'shy']) {
    const button = dialog.locator(`[data-resource-id="${name}"] .resource-play`);
    await expect(button).toBeEnabled();
    await button.click();
    await expect(dialog.getByTestId('performance-face')).toContainText(name);
  }
  await dialog.getByRole('button', { name: '恢复自然', exact: true }).click();
  await expect(dialog.getByTestId('performance-face')).toContainText('中性');
});

test('queued cues follow visible text, while transcript stays plain', async ({ page }) => {
  await page.route('**/api/chat', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.presentation?.expressions.length).toBe(4);
    const event = { t: 'sentence', no: 0, text: '你真的来了，不过你刚才去了哪里呀？', at: '', cues: [
      { id: '0:0', offset: 0, expression: { name: 'happy', intensity: 1 } },
      { id: '0:1', offset: 6, expression: { name: 'curious', intensity: 1 } },
      { id: '0:2', offset: 12, expression: { name: 'shy', intensity: 1 }, motion: 'motions/Hiyori_m04.motion3.json' },
    ] };
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(event)}\n\ndata: {"t":"done"}\n\n` });
  });
  await page.goto('/#/chat');
  await expect.poll(() => presentation(page).then(snapshot => snapshot?.expressions.length ?? 0)).toBe(4);
  await waitForChatReady(page);
  await page.getByPlaceholder(/输入|说点/).fill('你好');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => face(page)).toBe('happy');
  await expect.poll(() => face(page)).toBe('curious');
  await expect.poll(() => face(page)).toBe('shy');
  await expect(page.locator('.subtitle')).not.toContainText('ACT');
  await expect.poll(() => face(page), { timeout: 10000 }).toBe(null);
});


test('short audio does not rush the remaining text or its late cue', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json();
  state.avatarId = 'builtin';
  state.settings.general = { ...state.settings.general, lang: 'zh', voiceInput: false, textSpeed: 0, sentenceSpeed: 100 };
  state.settings.llm = { url: 'http://preview.test', model: 'preview', key: '' };
  state.settings.tts = { url: 'http://tts.test', voice: 'reference.wav', prompt: '', key: '' };
  await page.route('**/api/state', (route) => route.fulfill({ json: state }));
  await page.route('**/api/tts/speech', (route) => route.fulfill({ contentType: 'audio/pcm', headers: { 'X-Sample-Rate': '32000' }, body: Buffer.alloc(640) }));
  await page.route('**/api/chat', (route) => route.fulfill({ contentType: 'text/event-stream', body: 'data: ' + JSON.stringify({
    t: 'sentence', no: 0, text: '我先慢慢地说这一句话，然后才有一点点害羞。', at: '', cues: [
      { id: '0:0', offset: 0, expression: {name: 'happy', intensity: 1} },
      { id: '0:1', offset: 15, expression: {name: 'shy', intensity: 1} }
    ]
  }) + '\n\ndata: {"t":"done"}\n\n' }));
  await page.goto('/#/chat');
  await expect.poll(() => presentation(page).then(snapshot => snapshot?.expressions.length ?? 0)).toBe(4);
  await waitForChatReady(page);
  await page.getByPlaceholder(/输入|说点|和 momo/).fill('你好');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => face(page)).toBe('happy');
  await expect.poll(() => face(page)).toBe('shy');
  await expect(page.locator('.subtitle')).toHaveText('我先慢慢地说这一句话，然后才有一点点害羞。');
});
