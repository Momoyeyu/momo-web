import { test, expect } from '@playwright/test';

for (const failure of ['network', 'upstream error', 'empty stream']) {
  test(`unanswered ${failure} leaves no backlog entry`, async ({ page, request }) => {
    const state = await (await request.get('/api/state')).json();
    state.settings.general = { ...state.settings.general, lang: 'en', voiceInput: false };
    state.settings.llm = { url: 'http://preview.test', key: '', model: 'preview' };
    // Intercept all writes; the user's real history and settings stay intact.
    await page.route('**/api/state', route => route.fulfill({ json: state }));
    await page.route('**/api/checkpoints/live', route => route.fulfill({ json: {
      summary: '', messages: [
        { role: 'user', text: 'Earlier question', at: 't' },
        { role: 'assistant', text: 'Earlier answer', at: 't' },
      ],
    } }));
    await page.route('**/api/chat', route => {
      if (failure === 'network') return route.abort('connectionrefused');
      return route.fulfill({ contentType: 'text/event-stream', body: failure === 'upstream error'
        ? 'data: {"t":"error","message":"LLM connection refused"}\n\n' : '' });
    });
    await page.goto('/#/chat');
    await expect(page.locator('.subtitle')).toHaveText('Earlier answer');
    await page.locator('.input-row input').fill('Failed input should not persist');
    const response = page.waitForRequest('**/api/chat');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await response;
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Backlog', exact: true }).click();
    await expect(page.locator('.bl-text')).toHaveText(['Earlier question', 'Earlier answer']);
  });
}
