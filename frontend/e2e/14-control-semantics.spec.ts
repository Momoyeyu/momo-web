import { expect, test, type Page } from '@playwright/test';
import { presentation } from './helpers/runtime';
import {waitForChatReady} from './helpers';

async function runtime(page: Page, action: string): Promise<any> {
  return page.evaluate(async (action) => {
    const entry = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/live2d/stage.ts')!;
    const stage = (await import(entry.name)).getStage();
    const core = stage.model.internalModel.coreModel;
    // Cubism restores its saved base after model.update(). Sample the values
    // actually submitted for rendering, after momo's composition hook.
    if (!stage.__assertFrame) {
      stage.__assertFrame = {cheek:0,mouth:0,arm:0};
      stage.model.internalModel.on('beforeModelUpdate', () => {
        stage.__assertFrame = {cheek:core.getParameterValueById('ParamCheek'),mouth:core.getParameterValueById('ParamMouthOpenY'),arm:core.getParameterValueById('ParamArmLA')};
      });
    }
    if (action === 'audio') stage.setMouthOpen(0.15, true);
    if (action === 'release') stage.setMouthOpen(0, false);
    if (action === 'mouth-motion') { stage.setPreviewMode('composed'); stage.previewMotion('motions/Hiyori_m02.motion3.json'); }
    return { ...stage.__assertFrame,
      mouthWeight: stage.speechMouth.sample(performance.now()).weight };
  }, action);
}

test.beforeEach(async ({page,request}) => {
  const state = await (await request.get('/api/state')).json();
  state.avatarId = 'builtin'; state.settings.general = {...state.settings.general,lang:'zh',voiceInput:false};
  const builtin = state.avatars.find((a: {builtin?:boolean})=>a.builtin);
  builtin.resources = {expressions:[],motions:[{name:'Idle/4',desc:'我保留的动作说明',label:'自定义合掌',context:'我的使用语境',enabled:false}]};
  await page.route('**/api/state',r=>r.fulfill({json:state}));
  await page.goto('/#/settings'); await page.getByRole('button',{name:'拓展',exact:true}).click();
  await page.locator('.avatar-row').first().click();
  await expect(page.locator('[data-resource-id="happy"] .resource-play')).toBeEnabled();
});

test('migration preserves edits and disabled flags while exposing separate semantic fields', async ({page}) => {
  const dialog=page.getByRole('dialog'); await dialog.getByRole('button',{name:/动作\s*10/}).click();
  const row=dialog.locator('[data-resource-id="motions/Hiyori_m06.motion3.json"]');
  await expect(row.locator('input[type=checkbox]')).not.toBeChecked();
  await expect(row.getByRole('textbox',{name:/实际表现/})).toHaveValue('我保留的动作说明');
  await expect(row.getByRole('textbox',{name:/名称/})).toHaveValue('自定义合掌');
  await row.getByRole('textbox',{name:/适用语境/}).fill('测试时的期待场景');
  await expect(row.locator('.resource-play')).toBeEnabled();
  await expect.poll(()=>presentation(page,true).then(s=>s?.motions.find(r=>r.name==='motions/Hiyori_m06.motion3.json')?.context)).toBe('测试时的期待场景');
  expect((await presentation(page))!.motions.some(r=>r.name==='motions/Hiyori_m06.motion3.json')).toBe(false);
});

test('real parameters follow face previews, combined gestures, reset and speech ownership', async ({page}) => {
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'恢复自然',exact:true}).click();
  const baseline=await runtime(page,'read');
  await expect.poll(()=>runtime(page,'read').then(v=>v.arm)).toBe(-10);
  await dialog.locator('[data-resource-id="shy"] .resource-play').click();
  await expect.poll(()=>runtime(page,'read').then(v=>v.cheek)).toBeGreaterThan(0.9);
  await dialog.getByRole('button',{name:'组合',exact:true}).click();
  await dialog.getByRole('button',{name:/动作\s*10/}).click();
  await dialog.locator('[data-resource-id="motions/Hiyori_m04.motion3.json"] .resource-play').click();
  await expect(dialog.getByTestId('performance-face')).toHaveText('shy');
  await expect.poll(()=>runtime(page,'read').then(v=>v.cheek)).toBeGreaterThan(0.9);
  await dialog.getByRole('button',{name:'原始',exact:true}).click();
  await expect(dialog.getByTestId('performance-face')).toHaveText('中性');
  await dialog.getByRole('button',{name:'恢复自然',exact:true}).click();
  await expect.poll(()=>runtime(page,'read').then(v=>v.cheek)).toBeLessThanOrEqual(baseline.cheek+0.05);
  // Use the chat compositor on the same real model, not the raw preview bypass.
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.evaluate(async()=>{
    const entry=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/live2d/stage.ts')!;
    const stage=(await import(entry.name)).getStage();stage.setChatVisible(true);
  });
  await runtime(page,'mouth-motion');
  await expect.poll(()=>runtime(page,'read').then(v=>v.mouth)).toBeGreaterThan(0.8);
  await runtime(page,'audio');
  await expect.poll(()=>runtime(page,'read').then(v=>v.mouth)).toBeCloseTo(0.15,1);
  await runtime(page,'release');
  await expect.poll(()=>runtime(page,'read').then(v=>v.mouthWeight)).toBe(0);
  await expect.poll(()=>runtime(page,'read').then(v=>v.mouth)).toBeGreaterThan(0.8);
});

test('configured real TTS drives mouth opening and releases the channel after drain', async ({page,request}) => {
  test.skip(process.env.MOMO_REAL_TTS_E2E !== '1', 'Opt in: uses the configured real speech service.');
  test.setTimeout(120_000);
  const state=await(await request.get('/api/state')).json();
  test.skip(!state.settings.tts.url || !state.settings.tts.voice, 'No speech service/voice configured.');
  state.settings.general={...state.settings.general,lang:'zh',chatLang:'zh',voiceInput:false,textSpeed:70,sentenceSpeed:100,voiceVolume:100};
  await page.route('**/api/state',r=>r.fulfill({json:state}));
  await page.route('**/api/life/history**',r=>r.fulfill({json:{summary:'',messages:[]}}));
  await page.route('**/api/chat',r=>r.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({t:'sentence',no:0,text:'欢迎回来，今天有什么开心的事情想和我说呢？',at:'',cues:[{id:'tts:0',offset:0,expression:{name:'happy',intensity:0.8}}]})+'\n\ndata: {"t":"done"}\n\n'}));
  await page.goto('/#/chat');await expect.poll(()=>presentation(page).then(s=>s?.expressions.length??0)).toBe(4);
  await page.evaluate(async()=>{
    const entry=performance.getEntriesByType('resource').find(e=>new URL(e.name).pathname==='/src/live2d/stage.ts')!;
    const stage=(await import(entry.name)).getStage(); (window as any).__audioPeak=0;
    stage.model.internalModel.on('beforeModelUpdate',()=>{
      if(stage.speechMouth.sample(performance.now()).weight===1) (window as any).__audioPeak=Math.max((window as any).__audioPeak,stage.model.internalModel.coreModel.getParameterValueById('ParamMouthOpenY'));
    });
  });
  await waitForChatReady(page);
  await page.locator('.input-row input').fill('口型联调');await page.getByRole('button',{name:'发送',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__audioPeak),{timeout:90_000}).toBeGreaterThan(0.05);
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeVisible({timeout:90_000});
  await expect.poll(()=>runtime(page,'read').then(v=>v.mouthWeight)).toBe(0);
});
