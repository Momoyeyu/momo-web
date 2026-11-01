import {test,expect} from './fixtures';
for(const [lang,text] of [['zh','你能感受到我的心吗'],['en','Can you feel my heart?'],['ja','私の心、感じる？']]){
 test(`terminal slogan types without moving the layout (${lang})`,async({page,request},info)=>{
  const state=await (await request.get('/api/state')).json();state.settings.general.lang=lang;
  await page.route('**/api/state',r=>r.fulfill({json:state}));
  await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
  await page.addInitScript(()=>{const scope=window as unknown as {promptSamples:{count:number;y:number;center:number}[]};scope.promptSamples=[];const sample=()=>{const prompt=document.querySelector('.terminal-prompt svg'),output=document.querySelector('.terminal-output');if(prompt&&output){const box=prompt.getBoundingClientRect();scope.promptSamples.push({count:output.textContent?.length??0,y:box.y,center:box.y+box.height/2});}requestAnimationFrame(sample);};requestAnimationFrame(sample);});
  await page.goto('/');
  const slogan=page.locator('.title-tagline'),output=slogan.locator('.terminal-output');
  await expect(slogan).toHaveAttribute('aria-label',text);
  await page.waitForFunction(full=>{const value=document.querySelector('.terminal-output')?.textContent??'';return value.length>0&&value.length<full.length;},text,{polling:'raf'});
  const before=await slogan.boundingBox();
  await expect(output).toHaveText(text);
  expect(await slogan.boundingBox()).toEqual(before);
  const samples=await page.evaluate(()=>(window as unknown as {promptSamples:{count:number;y:number;center:number}[]}).promptSamples);
  const stable=samples;
  // Parent brand entrance is allowed to move; compare the empty tail and typing.
  const first=stable.findIndex(s=>s.count>0),empty=stable.slice(0,first).at(-1)!;
  expect(empty).toBeTruthy();
  for(const sample of stable.slice(first))expect(Math.abs(sample.center-empty.center)).toBeLessThan(.5);
  const alignment=await slogan.evaluate(el=>{const p=el.querySelector('.terminal-prompt svg')!.getBoundingClientRect(),o=el.querySelector('.terminal-output')!.getBoundingClientRect();return Math.abs(p.y+p.height/2-o.y-o.height/2);});
  expect(alignment).toBeLessThan(.5);
  await page.screenshot({path:info.outputPath(`${lang}-terminal.png`)});
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await expect(output).toHaveText(text);
  expect(await slogan.locator('.terminal-line .terminal-cursor').evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
 });
}
