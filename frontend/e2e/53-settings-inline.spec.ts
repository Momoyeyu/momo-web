import {expect, test} from './fixtures';
import {openTab, pickSelect} from './helpers';

test('sound preview offers the existing palette and plays the selected action inline', async ({page}) => {
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (!this.loop) {
        document.documentElement.dataset.soundStarts = String(Number(document.documentElement.dataset.soundStarts || 0) + 1);
      }
      return start.apply(this, args);
    };
  });
  await openTab(page, '声音');
  const sound = page.locator('#config-sound');
  await expect(sound.getByRole('button', {name:'音效风格'})).toHaveCount(1);
  await pickSelect(page, '试听动作', '确认操作', '#config-sound');
  await expect(sound.getByRole('button', {name:'播放音效', exact:true})).toBeEnabled();
  // Begin watching after the select’s own UI sound has started.
  const played = async () => Number(await page.locator('html').getAttribute('data-sound-starts') || 0);
  const previous = await played();
  await sound.getByRole('button', {name:'播放音效', exact:true}).click();
  await expect.poll(played).toBeGreaterThan(previous);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('vision verification gates the inline switch and ASR readiness is visible', async ({page}) => {
  await page.route('**/api/vision/capability', route => route.fulfill({json:{verified:false}}));
  await page.route('**/api/vision/probe', route => route.fulfill({json:{ok:true,detail:'verified'}}));
  await page.route('**/api/resources/status', route => route.fulfill({json:{
    asr:{ready:true,engine:'SenseVoice',language:'auto',missing:[]},embedding:{state:'ready'},index:{state:'ready'},
  }}));
  await openTab(page, '模型');
  const models = page.locator('#config-models');
  const vision = models.getByRole('switch', {name:'识图'});
  await expect(vision).toBeDisabled();
  await models.getByRole('button', {name:'验证识图能力'}).click();
  await expect(vision).toBeEnabled();
  await vision.click();
  await expect(vision).toHaveAttribute('aria-checked','true');
  await vision.click();
  await expect(models.getByText(/SenseVoice/)).toBeVisible();
  await expect(models.getByText('已就绪', {exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an installed mod can be enabled and disabled from its list row', async ({page}) => {
  const mod = {id:'fixture.local',name:'Fixture mod',version:'1.0.0',kind:'content',source:'local',platforms:['*'],enabled:false,capabilities:[],resources:[]};
  await page.route(/\/api\/mods$/, route => route.fulfill({json:{mods:[mod]}}));
  await page.route('**/api/mods/fixture.local', route => {
    mod.enabled = route.request().postDataJSON().enabled;
    return route.fulfill({json:mod});
  });
  await openTab(page, '模组');
  const toggle = page.locator('#config-mods').getByRole('switch', {name:'Fixture mod'});
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('desktop access shows its status and opens the permission guide directly', async ({page, baseURL}) => {
  await page.addInitScript(base => {
    window.momoDesktop = {getRuntime: async () => ({baseUrl:base, token:'isolated-desktop-access'})};
  }, baseURL!);
  await page.route('**/api/intro', route => route.fulfill({json:{phase:'completed',configurationValid:true}}));
  await page.route('**/api/computer/status', route => route.fulfill({json:{desktopAccessGranted:true}}));
  await page.route('**/api/computer/access', route => route.fulfill({json:{available:true,granted:true,blocked:[]}}));
  await page.route('**/api/computer/access/system', route => route.fulfill({json:{screenPermission:true,inputPermission:true,applications:[]}}));
  await openTab(page, '桌面');
  const access = page.locator('#config-desktop .opt-row').filter({hasText:'桌面访问'});
  await expect(access.getByRole('status')).toHaveText('已授权');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await access.getByRole('button',{name:'打开授权引导'}).click();
  const guide = page.getByRole('dialog',{name:'桌面访问',exact:true});
  await expect(guide.getByRole('button',{name:'撤回桌面访问'})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('an in-progress export stays locked across browser history navigation', async ({page}) => {
  let finishExport!: () => void;
  const responseReady = new Promise<void>(resolve => {finishExport=resolve;});
  await page.route('**/api/data/export', async route => {
    await responseReady;
    await route.fulfill({status:503,json:{}});
  });
  try {
    await page.goto('/#/title');
    await expect(page.locator('.title-screen')).toBeVisible();
    await openTab(page,'存档');
    await page.getByRole('button',{name:'导出文件',exact:true}).click();
    const progress=page.getByRole('dialog',{name:'备份',exact:true});
    await expect(progress).toBeVisible();

    await page.goBack();
    await expect(page.locator('.settings-page')).toHaveCount(0);
    await page.goForward();
    await expect(progress).toBeVisible();
    await expect(page.locator('#config-archive button').filter({hasText:'选择文件'})).toBeDisabled();

    finishExport();
    await expect(progress).toHaveCount(0);
    await expect(page.locator('#config-archive').getByRole('alert')).toHaveText('导出失败，请重试。');
    await expect(page.getByRole('button',{name:'导出文件',exact:true})).toBeEnabled();
  } finally {
    finishExport();
  }
});
