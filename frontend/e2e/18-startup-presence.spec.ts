import { test, expect, type Page } from './fixtures';

async function fixture(page: Page, waitForState: Promise<void> = Promise.resolve(), language = 'zh', firstLaunch = false) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if(url.pathname.startsWith('/api/meeting/'))return route.fulfill(url.pathname.endsWith('/leave')?{status:204}:{json:{leaseId:'visual-lease',epoch:1,expiresIn:60}});
    let body: unknown = {};
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'GET') await waitForState;
      body = {settings:{general:{lang:language,voiceInput:false},llm:{url:'',model:'',key:''},tts:{url:'',key:'',voice:'',prompt:''}}};
    }
    if (url.pathname === '/api/intro') body = {phase:firstLaunch?'setup':'completed',languageConfirmed:false,configurationValid:false};
    if (url.pathname === '/api/life/history') body = {summary:'',messages:[],hasMore:false,nextBefore:null};
    if (url.pathname === '/api/onboarding') body = {stage:firstLaunch?'new':'completed',busy:false,generation:0,configured:false};
    if (url.pathname === '/api/checkpoints' || url.pathname === '/api/memories') body = [];
    if (url.pathname === '/api/resources/status') body = {asr:{ready:true},embedding:{state:'ready'},index:{state:'ready'}};
    if (url.pathname === '/api/social/accounts') body = {accounts:[],providers:[]};
    if (url.pathname === '/api/social/accounts/retired/records') body = {records:[]};
    await route.fulfill({json:body});
  });
}

for (const asset of ['/stage/stage-room.jpg', '/live2d/hiyori/Hiyori.model3.json']) {
test(`title crossfades independently of ${asset}, then settings guidance is available`, async ({page}, info) => {
  await fixture(page, Promise.resolve(), 'zh', true);
  let releaseRoom!:()=>void;
  const room = new Promise<void>(resolve=>{releaseRoom=resolve;});
  let requested = false;
  await page.route(`**${asset}`, async route=>{requested=true;await room;await route.continue();});
  await page.addInitScript(()=>{
    const scope=window as unknown as {__startupFrames:{time:number;opacity:number;inert:boolean;setup:boolean}[]};
    scope.__startupFrames=[];
    const sample=()=>{
      const screen=document.getElementById('startup');
      if(screen)scope.__startupFrames.push({time:performance.now(),opacity:Number(getComputedStyle(screen).opacity),
        inert:!!document.getElementById('root')?.hasAttribute('inert'),setup:!!document.querySelector('.first-meeting-setup')});
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto('/', {waitUntil:'domcontentloaded'});
  await expect(page.locator('.title-screen')).toBeAttached();
  await expect.poll(()=>requested).toBe(true);
  // A room resource cannot hold the title startup or implicitly Boot momo.
  await expect(page.locator('#startup')).toHaveCount(0);
  await expect(page.locator('.title-screen')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const frames=await page.evaluate(()=>(window as unknown as {__startupFrames:{time:number;opacity:number;inert:boolean;setup:boolean}[]}).__startupFrames);
  const fading=frames.filter(frame=>frame.opacity>.01&&frame.opacity<.99);
  expect(fading.length).toBeGreaterThan(12);
  expect(fading.at(-1)!.time-fading[0].time).toBeGreaterThan(400);
  expect(fading.every(frame=>frame.inert&&!frame.setup)).toBe(true);
  releaseRoom();
  await page.locator('[data-intro=settings]').click();
  await expect(page.locator('.settings-page')).toBeVisible();
  await info.attach('startup-crossfade-frames',{body:JSON.stringify(frames),contentType:'application/json'});
  await page.screenshot({path:info.outputPath('first-launch-ready.png')});
});
}

test('unavailable first-launch artwork falls back without trapping the configuration', async ({page}) => {
  await fixture(page, Promise.resolve(), 'zh', true);
  await page.route('**/live2d/hiyori/Hiyori.model3.json', route=>route.abort());
  await page.route('**/stage/stage-room.jpg', route=>route.abort());
  await page.goto('/');
  await expect(page.locator('#startup')).toHaveCount(0);
  await expect(page.locator('.title-screen')).toBeVisible();
  await page.locator('[data-intro=settings]').click();
  await expect(page.locator('.settings-page')).toBeVisible();
});

test('a stalled model has a bounded startup wait', async ({page}) => {
  await fixture(page, Promise.resolve(), 'zh', true);
  let release!:()=>void;
  const stalled = new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/live2d/hiyori/Hiyori.model3.json', async route=>{await stalled;await route.abort();});
  try {
    await page.goto('/', {waitUntil:'domcontentloaded'});
    await expect(page.locator('#startup')).toHaveCount(0, {timeout:6000});
    await expect(page.locator('.title-screen')).toBeVisible();
    await page.locator('[data-intro=settings]').click();
    await expect(page.locator('.settings-page')).toBeVisible();
  } finally { release(); }
});

test('static presence precedes React; real startup stages animate then release the game', async ({page,request}, info) => {
  const html=await (await request.get('/')).text();
  expect(html).toContain('id="startup"');
  expect(html).toContain('href="/startup.css"');
  let restore!:()=>void;
  const restoring=new Promise<void>(resolve=>{restore=resolve;});
  await fixture(page,restoring);
  await page.addInitScript(()=>{
    const target=window as unknown as {__startupReady:boolean;__TAURI_INTERNALS__:unknown};
    target.__startupReady=false;
    target.__TAURI_INTERNALS__={invoke:async()=>{
      if(!target.__startupReady)throw 'Backend is starting';
      return {baseUrl:location.origin,token:'synthetic-startup-test'};
    }};
  });
  await page.goto('/');
  const screen=page.locator('#startup');
  await expect(screen).toHaveAttribute('data-stage','connecting');
  await expect(page.locator('#root')).toHaveAttribute('inert','');
  await expect.poll(()=>page.locator('.startup-art img').evaluate((image)=>image instanceof HTMLImageElement && image.complete && image.naturalWidth>0)).toBe(true);
  expect(await screen.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(24, 21, 31)');
  const movement=await page.locator('.startup-track-light').evaluate(el=>getComputedStyle(el).transform);
  await page.waitForTimeout(250); // Observe actual CSS motion while the backend remains pending.
  expect(await page.locator('.startup-track-light').evaluate(el=>getComputedStyle(el).transform)).not.toBe(movement);
  await page.screenshot({path:info.outputPath('startup-connecting.png')});
  await page.evaluate(()=>{(window as unknown as {__startupReady:boolean}).__startupReady=true;});
  await expect(screen).toHaveAttribute('data-stage','restoring');
  await expect(page.locator('.startup-message')).toHaveText('正在找回相处的片刻');
  restore();
  await expect(page.locator('.title-screen')).toBeVisible();
  await expect(screen).toHaveCount(0);
  await expect(page.locator('#root')).not.toHaveAttribute('inert');
  await expect(page.locator('#root')).not.toHaveAttribute('aria-hidden');
  await page.locator('.menu-item').filter({hasText:'设置'}).click();
  await expect(page.locator('.settings-page')).toBeVisible();
});

test('failed native startup stops the scene, hides private errors, and retries successfully', async ({page},info)=>{
  await fixture(page);
  await page.addInitScript(()=>{
    (window as unknown as {__TAURI_INTERNALS__:unknown}).__TAURI_INTERNALS__={invoke:async()=>{
      if(!sessionStorage.getItem('startup-failed-once')){
        sessionStorage.setItem('startup-failed-once','yes');
        throw 'private runtime failure: token=must-not-appear';
      }
      return {baseUrl:location.origin,token:'synthetic-startup-test'};
    }};
  });
  await page.goto('/');
  await expect(page.locator('#startup')).toHaveAttribute('data-stage','error');
  await expect(page.getByRole('alert')).toHaveText('这次见面还没准备好');
  await expect(page.locator('body')).not.toContainText('must-not-appear');
  expect(await page.locator('.startup-art img').evaluate(el=>getComputedStyle(el).animationPlayState)).toBe('paused');
  await page.screenshot({path:info.outputPath('startup-error.png')});
  await page.getByRole('button',{name:'再试一次'}).click();
  await expect(page.locator('.title-screen')).toBeVisible();
  await expect(page.locator('#startup')).toHaveCount(0);
});

test('reduced motion and saved language apply without waiting for optional services', async ({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  let finish!:()=>void;
  const hold=new Promise<void>(resolve=>{finish=resolve;});
  await fixture(page,hold,'ja');
  await page.addInitScript(()=>localStorage.setItem('momo-web.v1',JSON.stringify({settings:{general:{lang:'ja',voiceInput:false}}})));
  await page.goto('/');
  await expect(page.locator('#startup')).toHaveAttribute('data-stage','restoring');
  await expect(page.locator('.startup-message')).toHaveText('一緒に過ごした時間を読み込んでいます');
  expect(await page.locator('.startup-art img').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  expect(await page.locator('.startup-track-light').evaluate(el=>getComputedStyle(el).animationName)).toBe('none');
  finish();
  await expect(page.locator('.title-screen')).toBeVisible();
  await expect(page.locator('#startup')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('lang','ja');
});

test('optional mascot artwork cannot block startup or the title controls', async ({page}) => {
  await fixture(page);
  await page.route('**/brand/momo-presence-v2.webp', route => route.abort());
  await page.goto('/');
  await expect(page.locator('#startup')).toHaveCount(0);
  await expect(page.locator('.title-screen')).toBeVisible();
  await page.locator('.menu-item').filter({hasText:'设置'}).click();
  await expect(page.locator('.settings-page')).toBeVisible();
});
