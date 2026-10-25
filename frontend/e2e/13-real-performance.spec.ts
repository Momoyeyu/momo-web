import { test, expect } from './fixtures';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const cases: {id:string; prompt:string; faces:string[]; avoidJoy:boolean; guided?:boolean}[] = JSON.parse(readFileSync(new URL('./fixtures/performance-prompts.json', import.meta.url), 'utf8'));
import { presentation } from './helpers/runtime';
import {waitForChatReady} from './helpers';

const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
function realTurn(body: unknown): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const child = execFile(join(backend,'.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), [join(backend,'tests/helpers/real_performance_turn.py')],
      { cwd: backend, env:{...process.env,PYTHONIOENCODING:'utf-8'}, timeout: 100_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    child.stdin!.end(JSON.stringify(body));
  });
}

test('real provider chooses calibrated controls and the stage executes them', async ({ page, request }, testInfo) => {
  test.skip(process.env.MOMO_REAL_LLM_E2E !== '1', 'Opt in: uses the configured real LLM, with isolated temporary backend data.');
  test.setTimeout(600_000);
  const state = await (await request.get('/api/state')).json();
  state.avatarId = 'builtin';
  // Use calibrated defaults here. Legacy custom settings have separate migration tests.
  state.avatars = state.avatars.map((a: {builtin?: boolean}) => a.builtin ? {...a, resources: undefined} : a);
  state.settings.general = {...state.settings.general, lang: 'zh', voiceInput: false, textSpeed: 70, sentenceSpeed: 100};
  state.settings.tts = { url: '', key: '', voice: '', prompt: '' };
  const results: object[] = [];
  let events: any[] = [];
  await page.route('**/api/state', r => r.fulfill({json: state}));
  await page.route('**/api/life/history**', r => r.fulfill({json: {summary: '', messages: []}}));
  await page.route('**/api/chat/interrupt', r => r.fulfill({status: 204}));
  await page.route('**/api/chat', async route => {
    const result = await realTurn(route.request().postDataJSON());
    expect(result.status).toBe(200);
    events = result.body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    await route.fulfill({status: result.status, contentType:'text/event-stream', body: result.body});
  });
  const selected = process.env.MOMO_REAL_CASES ? cases.filter(c => process.env.MOMO_REAL_CASES!.split(',').includes(c.id)) : cases;
  for (const c of selected) {
    await page.goto(`/?performance-case=${c.id}#/chat`);
    await expect.poll(() => presentation(page).then(s => s?.motions.length ?? 0)).toBe(10);
    const catalog = (await presentation(page))!;
    await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/live2d/stage.ts')!;
      const stage = (await import(entry.name)).getStage();
      const frames: any[] = []; (window as any).__performanceFrames = frames;
      let last = 0;
      stage.model.internalModel.on('beforeModelUpdate', () => {
        if (performance.now() - last < 100) return; last = performance.now();
        const core = stage.model.internalModel.coreModel;
        frames.push({ name:stage.getPresentation()?.expressionState.name,
          values:['ParamEyeLSmile','ParamBrowLY','ParamCheek'].map(id=>core.getParameterValueById(id)) });
      });
    });
    events = [];
    await waitForChatReady(page);
    await page.locator('.input-row input').fill(c.prompt);
    await page.getByRole('button', {name:'发送', exact:true}).click();
    await expect.poll(() => events.some(e => e.t === 'done' || e.t === 'error'), {timeout: 110_000}).toBe(true);
    expect(events.filter(e => e.t === 'error')).toEqual([]);
    const sentences = events.filter(e => e.t === 'sentence');
    const cues = sentences.flatMap(e => e.cues ?? []);
    const faces = cues.filter(cue => cue.expression).map(cue => cue.expression.name);
    const motions = cues.filter(cue => cue.motion).map(cue => cue.motion);
    expect(sentences.map(s => s.text).join('')).not.toContain('<|ACT');
    for (const cue of cues) {
      if (cue.expression) expect(catalog.expressions.some(r => r.name === cue.expression.name)).toBe(true);
      if (cue.motion) expect(catalog.motions.some(r => r.name === cue.motion)).toBe(true);
    }
    writeFileSync(testInfo.outputPath('real-performance.json'), JSON.stringify([...results,{id:c.id,prompt:c.prompt,text:sentences.map(s=>s.text).join(''),faces,motions}],null,2));
    if (c.faces.length) expect(faces.some(f => c.faces.includes(f))).toBe(true);
    if (c.avoidJoy) {
      expect(faces).not.toContain('happy'); expect(faces).not.toContain('shy');
      expect(motions).not.toContain('motions/Hiyori_m08.motion3.json');
      expect(motions).not.toContain('motions/Hiyori_m06.motion3.json');
    }
    await expect(page.getByRole('button',{name:'发送',exact:true})).toBeVisible({timeout:45_000});
    const trace = await page.evaluate(async () => {
      const entry = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/live2d/stage.ts')!;
      return (await import(entry.name)).getStage().getPerformanceTrace();
    });
    if (cues.length) expect(trace.some((t: {result:string}) => t.result === 'applied')).toBe(true);
    else expect(c.faces).toHaveLength(0);
    const frames = await page.evaluate(() => (window as any).__performanceFrames);
    if (c.avoidJoy) expect(frames.some((f:any) => f.name === 'happy' || f.name === 'shy')).toBe(false);
    if (c.faces.length) expect(frames.some((f:any) => c.faces.includes(f.name) && f.values.some((v:number)=>Math.abs(v)>0.1))).toBe(true);
    expect(trace.some((t: {result:string}) => /rejected|failed|unavailable|stale/.test(t.result))).toBe(false);
    const result = {id:c.id,prompt:c.prompt,text:sentences.map(s=>s.text).join(''),faces,motions,guided:c.guided??false,renderedFaces:[...new Set(frames.map((f:any)=>f.name).filter(Boolean))],withinSentenceChanges:sentences.some(s => (s.cues??[]).filter((q:any)=>q.expression).length>1),trace};
    if (c.guided) expect(result.withinSentenceChanges).toBe(true);
    results.push(result);
    writeFileSync(testInfo.outputPath('real-performance.json'), JSON.stringify(results,null,2));
    await testInfo.attach(c.id, {body:JSON.stringify(result,null,2),contentType:'application/json'});
    console.log(c.id,JSON.stringify({faces,motions}));
  }
  if (selected.length === cases.length) expect(results.filter((r:any)=>r.withinSentenceChanges).length).toBeGreaterThanOrEqual(3);
  await testInfo.attach('real-performance-results', {body: JSON.stringify(results,null,2),contentType:'application/json'});
});
