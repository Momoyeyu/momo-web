import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const backend = resolve(process.cwd(), '../backend');
type Result = {status:number;body:string;contentType:string;headers?:Record<string,string>};
const workers = new Map<string, {child: ReturnType<typeof spawn>; queue:{accept:(r:Result)=>void;reject:(e:Error)=>void}[]}>();
function call(directory: string, path: string, method = 'GET', body?: unknown, options = {}): Promise<Result> {
  let worker = workers.get(directory);
  if (!worker) {
    const child = spawn(join(backend, '.venv/bin/python'), [join(backend, 'tests/helpers/onboarding_request.py')], {env:{...process.env, MOMO_ONBOARDING_BRIDGE:'1'}});
    worker = {child, queue:[]}; workers.set(directory, worker);
    const own = worker;
    let buffer = '', err = '';
    child.stdout!.on('data', b => {
      buffer += b;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        const pending = own.queue.shift();
        try {pending?.accept(JSON.parse(line));} catch {pending?.reject(new Error('Invalid isolated bridge result'));}
      }
    });
    child.stderr!.on('data', b => err += b);
    child.on('close', code => {for (const p of own.queue.splice(0)) p.reject(new Error(err || `Bridge closed: ${code}`));});
  }
  const own = worker;
  return new Promise((accept, reject) => {
    own.queue.push({accept, reject});
    own.child.stdin!.write(JSON.stringify({directory,path,method,body,...options})+'\n');
  });
}
async function bridge(page: Page, directory: string, options = {}) {
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (!['/api/onboarding', '/api/onboarding/opening', '/api/state', '/api/chat', '/api/chat/interrupt'].includes(path) && !path.startsWith('/api/checkpoints') && !path.startsWith('/api/memories')) return route.continue();
    const result = await call(directory, path, req.method(), req.postData() ? req.postDataJSON() : undefined, options);
    if (!page.isClosed()) await route.fulfill({status: result.status, headers: result.headers, contentType: result.contentType, body: result.body});
  });
}
let directory = '';
test.beforeEach(() => {directory = mkdtempSync(join(tmpdir(), 'momo-first-meeting-'));});
test.afterEach(async ({page}) => {
  // Stop browser timers before removing interception; no delayed config write
  // may escape to the real backend during teardown.
  await page.close();
  const worker = workers.get(directory);
  if (worker) {
    const ended = new Promise<void>(resolve => worker.child.once('close', () => resolve()));
    worker.child.stdin!.end();
    await ended; workers.delete(directory);
  }
  rmSync(directory, {recursive:true,force:true});
});

test('first launch speaks first, remembers the name, and does not repeat after reload or new session', async ({page}) => {
  await bridge(page, directory);
  await page.goto('/');
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
  let live = JSON.parse((await call(directory, '/api/checkpoints/live')).body);
  expect(live.messages.map((m: {role:string}) => m.role)).toEqual(['assistant', 'assistant']);
  await page.locator('.input-row input').fill('叫我小星');
  await page.locator('.input-row input').press('Enter');
  await expect(page.locator('.subtitle')).toHaveText('你现在想聊什么？');
  expect(JSON.parse((await call(directory, '/api/onboarding')).body).stage).toBe('completed');
  const memories = JSON.parse((await call(directory, '/api/memories')).body);
  expect(JSON.stringify(memories)).toContain('小星');
  await page.reload();
  await expect(page.locator('.subtitle')).toHaveText('你现在想聊什么？');
  live = JSON.parse((await call(directory, '/api/checkpoints/live')).body);
  expect(live.messages.filter((m: {text:string}) => m.text.includes('我叫 momo'))).toHaveLength(1);
  await call(directory, '/api/checkpoints/live/new', 'POST');
  await page.goto('/');
  await expect(page).not.toHaveURL(/#\/chat$/);
});

test('refusal ends the first meeting without inventing a memory', async ({page}) => {
  await bridge(page, directory);
  await page.goto('/');
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
  await page.locator('.input-row input').fill('暂时不想说，聊聊游戏吧');
  await page.locator('.input-row input').press('Enter');
  await expect(page.locator('.subtitle')).toHaveText('没关系，我们先聊聊吧。');
  expect(JSON.parse((await call(directory, '/api/onboarding')).body).stage).toBe('skipped');
  expect(JSON.stringify(JSON.parse((await call(directory, '/api/memories')).body))).not.toContain('玩家希望');
});

test('refresh resumes the current question and model failure can be retried', async ({page}) => {
  await bridge(page, directory);
  await page.goto('/');
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
  await page.reload();
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
  await page.locator('.input-row input').fill('模拟失败');
  await page.locator('.input-row input').press('Enter');
  await expect(page.locator('.chat-error')).toBeVisible();
  expect(JSON.parse((await call(directory, '/api/onboarding')).body).stage).toBe('asking');
  const live = JSON.parse((await call(directory, '/api/checkpoints/live')).body);
  expect(live.messages.some((m:{text:string}) => m.text === '模拟失败')).toBe(false);
  await page.locator('.input-row input').fill('叫我小星');
  await page.locator('.input-row input').press('Enter');
  await expect(page.locator('.subtitle')).toHaveText('你现在想聊什么？');
});

test('unconfigured player sees a small connection gate and can continue', async ({page}) => {
  await bridge(page, directory, {configured: false});
  await page.goto('/');
  const dialog = page.getByRole('dialog', {name:'让 momo 与你相遇'});
  await expect(dialog).toBeVisible();
  await page.screenshot({path:'/tmp/momo-005-connect.png'});
  await dialog.getByLabel('服务地址').fill('https://preview.test');
  await dialog.getByLabel('模型名称').fill('test-model');
  await dialog.getByRole('button', {name:'开始相遇'}).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
});

test('existing player is not redirected into a first meeting', async ({page}) => {
  await bridge(page, directory, {legacy:true});
  await page.goto('/');
  await expect(page).not.toHaveURL(/#\/chat$/);
  expect(JSON.parse((await call(directory, '/api/onboarding')).body).stage).toBe('legacy');
});

test('real LLM first meeting forms a real editable memory', async ({page}) => {
  test.skip(process.env.MOMO_REAL_ONBOARDING_E2E !== '1', 'opt-in real provider');
  test.setTimeout(120_000);
  await bridge(page, directory, {real: true});
  await page.goto('/');
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
  await page.locator('.input-row input').fill('你好 momo，叫我小星就好。');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/chat');
  await page.locator('.input-row input').press('Enter');
  const body = await (await response).text();
  expect(body).not.toContain('"t": "error"');
  await expect.poll(async () => JSON.parse((await call(directory, '/api/onboarding', 'GET', undefined, {real:true})).body).stage, {timeout:90_000}).toBe('completed');
  await expect.poll(async () => (await page.locator('.subtitle').innerText()).includes('小星'), {timeout:60_000}).toBe(true);
  await expect(page.getByRole('button', {name:'发送', exact:true})).toBeVisible({timeout:60_000});
  const memories = JSON.parse((await call(directory, '/api/memories', 'GET', undefined, {real:true})).body);
  expect(JSON.stringify(memories)).toContain('玩家希望被称为');
  expect(JSON.stringify(memories)).toContain('小星');
  await page.screenshot({path:'/tmp/momo-005-first-meeting.png'});
});


test('typing before the model loads resolves the name without a late scripted intro', async ({page}) => {
  await bridge(page, directory);
  await page.route('**/live2d/hiyori/Hiyori.model3.json', async route => {
    await new Promise(resolve => setTimeout(resolve, 3500));
    await route.continue();
  });
  await page.goto('/');
  await page.locator('.input-row input').fill('叫我小星');
  await page.locator('.input-row input').press('Enter');
  await expect(page.locator('.subtitle')).toHaveText('你现在想聊什么？');
  const live = JSON.parse((await call(directory, '/api/checkpoints/live')).body);
  expect(live.messages.some((m:{text:string}) => m.text.includes('我叫 momo'))).toBe(false);
  expect(JSON.parse((await call(directory, '/api/onboarding')).body).stage).toBe('completed');
});

test('blocked autoplay falls back to subtitles and finishes the opening', async ({page}) => {
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        Object.defineProperty(this, 'state', {get: () => 'suspended'});
      }
      override resume() { return new Promise<void>(() => {}); }
    };
  });
  await bridge(page, directory, {tts:true});
  await page.route('**/api/tts/speech', route => route.fulfill({status:200, headers:{'x-sample-rate':'24000'}, contentType:'application/octet-stream', body:Buffer.alloc(4800, 20)}));
  await page.goto('/');
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
  await expect(page.getByRole('button', {name:'终止', exact:true})).not.toBeVisible();
  expect(JSON.parse((await call(directory, '/api/onboarding')).body).stage).toBe('asking');
});


test('brand-new installation can save its very first model configuration', async ({page}) => {
  await bridge(page, directory, {pristine:true});
  await page.goto('/');
  const dialog = page.getByRole('dialog', {name:'让 momo 与你相遇'});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('服务地址').fill('https://preview.test');
  await dialog.getByLabel('模型名称').fill('test-model');
  await dialog.getByRole('button', {name:'开始相遇'}).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.subtitle')).toHaveText('我该怎么称呼你呀？');
});
