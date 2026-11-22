import {openModLibrary} from './mod-fixtures';
import {expect, test} from './fixtures';
import {openTab} from './helpers';

test('all three previews play through the inline controls', async ({page,request}) => {
  const state = await (await request.get('/api/state')).json();
  Object.assign(state.settings.tts,{url:'http://tts.test',voice:'ref.wav'});
  await request.put('/api/state',{data:state});
  let connected = false;
  await page.route('**/api/tts/speech', route => connected ? route.fulfill({
    contentType:'audio/pcm', headers:{'X-Sample-Rate':'32000'}, body:Buffer.alloc(6400),
  }) : route.fulfill({status:503,json:{detail:'TTS 连接失败：fixture connection reset'}}));
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
  await expect(sound.locator('.sel-face')).toHaveCount(0);
  const voice = sound.getByRole('button',{name:'试听语音',exact:true});
  const beforeFailure = await voice.boundingBox();
  await voice.click();
  await expect(voice).toHaveAttribute('data-tip',/无法连接|连接失败|检查.*网络/);
  expect(await voice.boundingBox()).toEqual(beforeFailure);
  connected = true;
  const played = async () => Number(await page.locator('html').getAttribute('data-sound-starts') || 0);
  for (const name of ['试听语音','试听音效','试听音乐']) {
    const before = await played();
    await sound.getByRole('button', {name, exact:true}).click();
    await expect.poll(played).toBeGreaterThan(before);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('vision verification gates the LLM switch and built-in ASR has no settings entry', async ({page}) => {
  await page.route('**/api/vision/capability', route => route.fulfill({json:{verified:false}}));
  await page.route('**/api/vision/probe', route => route.fulfill({json:{ok:true,detail:'verified'}}));
  await page.route('**/api/resources/status', route => route.fulfill({json:{
    asr:{ready:false,engine:'SenseVoice',language:'auto',missing:['model']},embedding:{state:'ready'},index:{state:'ready'},
  }}));
  await openTab(page, '模型');
  const models = page.locator('#config-models');
  await models.getByRole('button', {name:'配置模型'}).click();
  const details = page.getByRole('dialog');
  const vision = details.getByRole('switch', {name:'识图'});
  await expect(vision).toBeDisabled();
  await details.getByRole('button', {name:'验证识图能力'}).click();
  await expect(vision).toBeEnabled();
  await vision.click();
  await expect(vision).toHaveAttribute('aria-checked','true');
  await vision.click();
  await page.keyboard.press('Escape');
  await expect(models.locator('.config-model-row b')).toHaveText(['LLM', 'TTS']);
  await expect(page.locator('.config-document')).not.toContainText(/ASR|SenseVoice|内置语音资源不可用/);
  await openTab(page, '声音');
  await expect(page.locator('#config-sound').getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an installed mod can be enabled and disabled from its list row', async ({page}) => {
  const mod = {id:'fixture.local',name:'Fixture mod',version:'1.0.0',kind:'content',source:'local',platforms:['*'],enabled:false,capabilities:[],resources:[]};
  await page.route(/\/api\/mods$/, route => route.fulfill({json:{mods:[mod]}}));
  await page.route('**/api/mods/fixture.local', route => {
    mod.enabled = route.request().postDataJSON().enabled;
    return route.fulfill({json:mod});
  });
  const library=await openModLibrary(page);
  const toggle = library.getByRole('switch', {name:'Fixture mod'});
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('desktop access can be configured before Boot and keeps confirmed consent if status refresh fails', async ({page, baseURL}) => {
  await page.addInitScript(base => {
    window.momoDesktop = {
      getRuntime: async () => ({baseUrl:base, token:'isolated-desktop-access'}),
      openPermissionGuide: async kind => {document.documentElement.dataset.permission = kind;},
      setPermissionGuideGranted: async granted => {
        if (granted) document.documentElement.dataset.permission = 'granted';
      },
      onPermissionGuideClosed: listener => {
        window.addEventListener('test:permission-guide-closed', listener);
        return () => window.removeEventListener('test:permission-guide-closed', listener);
      },
    };
  }, baseURL!);
  await page.route('**/api/intro', route => route.fulfill({json:{phase:'completed',configurationValid:true}}));
  let granted=true, failStatus=false, inputPermission=true;
  await page.route('**/api/computer/status', route => failStatus
    ? route.fulfill({status:503,json:{}})
    : route.fulfill({json:{desktopAccessGranted:granted, desktopAllowed:true}}));
  await page.route('**/api/computer/access/consent',route=>{
    granted=route.request().postDataJSON().granted;
    return route.fulfill({json:{granted}});
  });
  await page.route('**/api/computer/access', route => route.fulfill({json:{available:true,granted,blocked:[]}}));
  await page.route('**/api/computer/access/system', route => route.fulfill({json:{screenPermission:true,inputPermission,applications:[]}}));
  await openTab(page, '操作');
  await expect(page.getByRole('button',{name:'返回',exact:true})).toBeVisible();
  const access = page.locator('#config-operations .opt-row').filter({hasText:'桌面访问'});
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const accessGroup = page.locator('#config-operations');
  const screen = accessGroup.locator('.opt-row').filter({hasText:'屏幕录制'});
  const input = accessGroup.locator('.opt-row').filter({hasText:'辅助功能'});
  await expect(screen.getByRole('button',{name:'已授权'})).toBeDisabled();
  await expect(input.getByRole('button',{name:'已授权'})).toBeDisabled();

  inputPermission=false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const authorize = input.getByRole('button',{name:'去授权'});
  const toggle=access.getByRole('switch',{name:'桌面访问',exact:true});
  await expect(authorize).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-permission', 'input');
  await authorize.click();
  await expect(page.locator('html')).toHaveAttribute('data-permission','input');
  inputPermission=true;
  await expect(page.locator('html')).toHaveAttribute('data-permission','granted');
  await page.evaluate(() => window.dispatchEvent(new Event('test:permission-guide-closed')));
  await expect(input.getByRole('button',{name:'已授权'})).toBeDisabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','false');
  failStatus=true;
  const failedRead=page.waitForResponse(response=>response.url().endsWith('/api/computer/status') && response.status()===503);
  await toggle.click();
  await failedRead;
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked','false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
    await openTab(page,'数据');
    await page.getByRole('button',{name:'导出备份',exact:true}).click();
    const progress=page.getByRole('dialog',{name:'备份',exact:true});
    await expect(progress).toBeVisible();

    await page.goBack();
    await expect(page.locator('.settings-page')).toHaveCount(0);
    await page.goForward();
    await expect(progress).toBeVisible();
    await expect(page.locator('#config-data button[aria-label="导入备份"]')).toBeDisabled();

    finishExport();
    await expect(progress).toHaveCount(0);
    await expect(page.locator('#config-data').getByRole('alert')).toHaveText('导出失败，请重试。');
    await expect(page.getByRole('button',{name:'导出备份',exact:true})).toBeEnabled();
  } finally {
    finishExport();
  }
});
