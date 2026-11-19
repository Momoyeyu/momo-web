import {test, expect} from './fixtures';
import {readState, writeState} from './helpers';

test('desktop startup asks once, waits for system access, and saves the user decision', async ({page, request, baseURL}) => {
  const state = await readState(request);
  Object.assign((state as any).settings.general, {lang:'zh'});
  await writeState(request, state);
  await page.addInitScript(base => {
    window.momoDesktop = {getRuntime: async () => ({baseUrl: base, token:'isolated-desktop-access'})};
  }, baseURL!);
  let granted: boolean | null = null;
  const requests: string[] = [];
  const system = {screenPermission:false, inputPermission:false, applications:[]};
  await page.route('**/api/intro', route => route.fulfill({json:{phase:'setup', languageConfirmed:false, configurationValid:false}}));
  await page.route('**/api/computer/access', route => route.fulfill({json:{available:true, granted, blocked:[]}}));
  await page.route('**/api/computer/access/system**', route => {
    if (route.request().method() === 'POST') {
      const kind = route.request().url().split('/').at(-1)!;
      requests.push(kind);
      if (kind === 'screen') system.screenPermission = true;
      if (kind === 'input') system.inputPermission = true;
    }
    return route.fulfill({json:system});
  });
  await page.route('**/api/computer/access/consent', route => {
    granted = route.request().postDataJSON().granted;
    return route.fulfill({json:{granted, blocked:[]}});
  });
  await page.goto('/#/');
  const guide = page.getByRole('dialog', {name:'桌面访问', exact:true});
  await expect(guide).toBeVisible({timeout:20000});
  await expect(page.locator('.intro-guide')).toHaveCount(0);
  const enable = guide.getByRole('button', {name:'启用桌面访问'});
  await expect(enable).toBeDisabled();
  expect(requests).toEqual([]);
  await guide.getByRole('button', {name:'去授权'}).first().click();
  await expect(enable).toBeDisabled();
  await guide.getByRole('button', {name:'去授权'}).click();
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(guide).toHaveCount(0);
  await expect(page.locator('.intro-guide')).toBeVisible();
  expect(granted).toBe(true);
  expect(requests).toEqual(['screen','input']);
  await page.reload();
  await expect(page.locator('.intro-guide')).toBeVisible({timeout:20000});
  await expect(guide).toHaveCount(0);
});
