import {test, expect, type Page} from './fixtures';

async function fixture(page: Page, lang = 'zh') {
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if(path.startsWith('/api/meeting/'))return route.fulfill(path.endsWith('/leave')?{status:204}:{json:{leaseId:'visual-lease',epoch:1,expiresIn:60}});
    if (!['/api/state','/api/onboarding','/api/life/history','/api/life/live','/api/memories'].includes(path)) return route.continue();
    if (request.method() !== 'GET') return route.fulfill({status:204});
    const json = path === '/api/state' ? {settings:{general:{lang,voiceInput:false},llm:{url:'https://fixture.test',key:'',model:'fixture'}}}
      : path === '/api/onboarding' ? {stage:'completed',configured:true}
      : path === '/api/life/history' ? {messages:[],summary:'',hasMore:false,nextBefore:null} : [];
    await route.fulfill({json});
  });
  await page.goto('/');
  await expect(page.locator('.title-screen')).toBeVisible();
}

for (const lang of ['zh','en','ja']) {
  test(`title keeps ${lang} controls below the brand and clear of the right silhouette`, async ({page},info) => {
    await fixture(page,lang);
    await expect.poll(() => page.locator('.title-menu .menu-item').last().evaluate(element=>Number(getComputedStyle(element).opacity))).toBe(1);
    for (const width of [960,1280]) {
      await page.setViewportSize({width,height:800});
      const layout = await page.evaluate(() => {
        const rect = (selector:string) => document.querySelector(selector)!.getBoundingClientRect();
        const brand=rect('.title-brand'),menu=rect('.title-menu'),art=rect('.title-presence'),tagline=rect('.title-tagline'),stage=rect('.app-stage');
        return {brandBottom:brand.bottom,brandLeft:brand.left,menuTop:menu.top,menuRight:menu.right,menuBottom:menu.bottom,
          artLeft:art.left,taglineLeft:tagline.left,stageBottom:stage.bottom,stageMid:stage.left+stage.width/2};
      });
      expect(layout.menuTop).toBeGreaterThan(layout.brandBottom+16);
      expect(layout.menuRight).toBeLessThan(layout.stageMid);
      expect(layout.menuRight).toBeLessThan(layout.artLeft);
      expect(layout.menuBottom).toBeLessThan(layout.stageBottom-16);
      expect(layout.taglineLeft).toBeGreaterThan(layout.brandLeft+30);
    }
    await page.screenshot({path:info.outputPath(`title-left-menu-${lang}.png`)});
  });
}

test('approved silhouette turns into visible ASCII, then releases real chat; settings retain RoPE', async ({page},info) => {
  await fixture(page);
  const portrait = page.locator('.title-presence');
  await expect(portrait).toHaveAttribute('src','/brand/momo-presence-v2.webp');
  await expect.poll(() => portrait.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1024);
  await expect.poll(() => page.locator('.title-menu .menu-item').last().evaluate(element=>Number(getComputedStyle(element).opacity))).toBe(1);
  await page.screenshot({path:info.outputPath('title-approved-silhouette.png')});
  await page.getByRole('button',{name:'启动 boot'}).click();
  const ink = page.locator('.chat-entry-canvas');
  await expect(ink).toBeVisible();
  await expect.poll(() => ink.getAttribute('data-phase')).toBe('glyphs');
  expect(Number(await ink.getAttribute('data-cells'))).toBeGreaterThan(1000);
  expect(await ink.evaluate(canvas => {
    const context = (canvas as HTMLCanvasElement).getContext('2d')!;
    return context.getImageData(0,0,canvas.width,canvas.height).data.some((value,index) => index % 4 === 3 && value > 0);
  })).toBe(true);
  await page.screenshot({path:info.outputPath('ascii-entry.png')});
  await expect(ink).toHaveCount(0);
  await expect(page.locator('.page-wrap.is-booting')).toHaveCount(0);
  await expect(page.locator('.input-row input')).toBeVisible();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.locator('.page-wrap.is-front')).toBeVisible();
  await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  await expect(page.locator('.settings-page')).toBeVisible();
  await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('balanced-settings-backup.png')});
});

for (const destination of ['设置', '记录']) {
  test(`returning from ${destination} uses RoPE without replaying the title entry`, async ({page}) => {
    await fixture(page);
    await page.getByRole('button',{name:'启动 boot'}).click();
    await expect(page.locator('.chat-entry-canvas')).toBeVisible();
    await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
    await page.getByRole('button',{name:destination,exact:true}).click();
    await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
    await page.evaluate(() => {
      document.body.dataset.returnAsciiEntries = '0';
      document.body.dataset.returnRopeSeen = 'false';
      new MutationObserver(records => {
        if (document.querySelector('.page-wrap.is-chat.is-front')) document.body.dataset.returnRopeSeen = 'true';
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches('.chat-entry-canvas') || node.querySelector('.chat-entry-canvas'))) {
            document.body.dataset.returnAsciiEntries = String(Number(document.body.dataset.returnAsciiEntries) + 1);
          }
        }
      }).observe(document.querySelector('.app-stage')!, {childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    });
    await page.getByRole('button',{name:'返回对话',exact:true}).click();
    // Observe the brief transition at mutation time, even if the click response
    // reaches Playwright after the 560ms animation has already finished.
    await expect(page.locator('body')).toHaveAttribute('data-return-rope-seen','true');
    await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
    await expect(page.locator('.page-wrap')).toHaveCount(1);
    await expect(page.locator('.input-row input')).toBeEditable();
    await expect(page.locator('body')).toHaveAttribute('data-return-ascii-entries','0');
    await expect(page.locator('.page-wrap.is-booting')).toHaveCount(0);
  });
}

test('rapid navigation cancels ASCII; only a new title-to-chat entry replays it', async ({page}) => {
  await fixture(page);
  await page.getByRole('button',{name:'启动 boot'}).click();
  await expect(page.locator('.chat-entry-canvas')).toBeVisible();
  await page.evaluate(() => {location.hash='/settings';});
  await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  await expect(page.locator('.settings-page')).toBeVisible();
  await page.evaluate(() => {location.hash='/chat';});
  await expect(page.locator('.page-wrap.is-chat.is-front')).toBeVisible();
  await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  await expect(page.locator('.input-row input')).toBeVisible();
  await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
  await page.evaluate(() => {location.hash='/title';});
  await expect(page.locator('.title-screen')).toBeVisible();
  await page.getByRole('button',{name:'启动 boot'}).click();
  await expect(page.locator('.chat-entry-canvas')).toBeVisible();
  await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  await expect(page.locator('.page-wrap')).toHaveCount(1);
});

test('missing decorative art and reduced motion never hold the dialogue behind a transition', async ({page}) => {
  await page.route('**/brand/momo-presence-v2.webp', route => route.abort());
  await fixture(page);
  await page.getByRole('button',{name:'启动 boot'}).click();
  await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  await expect(page.locator('.input-row input')).toBeVisible();
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(() => {location.hash='/title';});
  await expect(page.locator('.title-screen')).toBeVisible();
  await page.getByRole('button',{name:'启动 boot'}).click();
  await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  await expect(page.locator('.input-row input')).toBeVisible();
});
