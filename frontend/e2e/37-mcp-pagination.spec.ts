import {test, expect} from './fixtures';
import {openExtensionTab, readState, writeState} from './helpers';

test('many MCP entries page, search, and remove the original indexed record', async ({page, request}) => {
  const original = await readState(request);
  const seeded = structuredClone(original);
  seeded.settings.extensions = Array.from({length:17}, (_, i) => ({
    name: `Pagination MCP ${String(i).padStart(2, '0')}`, transport: 'http', enabled: false,
    endpoint: 'http://127.0.0.1:1/mcp', command: '', args: [], env: {}, headers: {},
  }));
  await writeState(request, seeded);
  try {
    await openExtensionTab(page, 'MCP');
    const panel = page.locator('#extension-panel-mcp');
    const rows = panel.locator('.ext-row');
    const firstPageNames = await rows.locator('.ext-name').allTextContents();
    expect(firstPageNames.length).toBeGreaterThan(0);
    expect(firstPageNames.length).toBeLessThan(17);
    await panel.locator('.pager-btn').last().click();
    await expect(rows.first()).not.toContainText(firstPageNames[0]!);
    await panel.locator('.list-search').fill('Pagination MCP 16');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Pagination MCP 16');
    await rows.getByRole('button', {name:'删除', exact:true}).click();
    await expect(rows).toHaveCount(0);
    await expect.poll(async () => (await readState(request)).settings.extensions.length).toBe(16);
    const remaining = (await readState(request)).settings.extensions;
    expect(remaining[0].name).toBe('Pagination MCP 00');
    expect(remaining.some((entry: {name: string}) => entry.name === 'Pagination MCP 16')).toBe(false);
    await panel.locator('.list-search').clear();
    await expect(rows.first()).toContainText('Pagination MCP 00');
  } finally {
    await writeState(request, original);
  }
});
