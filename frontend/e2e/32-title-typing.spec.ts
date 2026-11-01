import {test,expect} from './fixtures';
for(const [lang,text] of [['zh','你能感受到我的心吗'],['en','Can you feel my heart?'],['ja','私の心、感じる？']]){
 test(`terminal slogan types without moving the layout (${lang})`,async({page,request},info)=>{
  const state=await (await request.get('/api/state')).json();state.settings.general.lang=lang;
  await page.route('**/api/state',r=>r.fulfill({json:state}));
  await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
  await page.goto('/');
  const slogan=page.locator('.title-tagline'),output=slogan.locator('.terminal-output');
  await expect(slogan).toHaveAttribute('aria-label',text);
  await page.waitForFunction(full=>{const value=document.querySelector('.terminal-output')?.textContent??'';return value.length>0&&value.length<full.length;},text,{polling:'raf'});
  const before=await slogan.boundingBox();
  await expect(output).toHaveText(text);
  expect(await slogan.boundingBox()).toEqual(before);
  await page.screenshot({path:info.outputPath(`${lang}-terminal.png`)});
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await expect(output).toHaveText(text);
  expect(await slogan.locator('.terminal-line .terminal-cursor').evaluate(e=>getComputedStyle(e).animationName)).toBe('none');
 });
}
