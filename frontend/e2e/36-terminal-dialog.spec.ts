import {test,expect} from './fixtures';
import {bootChat} from './helpers';

for(const lang of ['zh','en','ja'])test(`terminal dialog aligns its prompts and preserves drawer/preview (${lang})`,async({page,request},info)=>{
 const state=await (await request.get('/api/state')).json();state.settings.general={...state.settings.general,lang,voiceInput:false};
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await page.route('**/api/meeting**',r=>r.fulfill({json:{leaseId:'terminal-fixture',epoch:1,expiresIn:3600,activation:'active',focus:false,phonePaused:false,busy:false,activity:null,presentation:null}}));
 await page.route('**/api/phone?**',r=>r.fulfill({json:{apps:[],accountKey:'terminal',pending:0,conversations:[],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null}}));
 await bootChat(page);
 for(const size of [{width:1440,height:900},{width:960,height:650},{width:800,height:450}]){
  await page.setViewportSize(size);
  const input=page.locator('.input-row input'),prompt=page.locator('.terminal-input-prompt svg');
  const before=(await prompt.boundingBox())!;
  await input.fill('');await input.focus();
  await page.screenshot({path:info.outputPath(`terminal-placeholder-${lang}-${size.width}.png`),caret:'initial'});
  await input.fill(lang==='zh'?'今天过得怎么样？':lang==='ja'?'今日はどんな一日だった？':'How was your day?');
  expect(await input.evaluate(el=>getComputedStyle(el).getPropertyValue('caret-shape'))).toBe('block');
  const after=(await prompt.boundingBox())!,field=(await input.boundingBox())!;
  expect(Math.abs(before.y-after.y)).toBeLessThan(.5);
  expect(Math.abs(after.y+after.height/2-field.y-field.height/2)).toBeLessThan(1);
  const rects=await page.evaluate(()=>{
   const box=(selector:string)=>{const r=document.querySelector(selector)!.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
   return {header:box('.nameplate-row'),output:box('.subtitle'),input:box('.input-row'),dialog:box('.dialog-box'),rail:box('.chat-toolbar'),stage:box('.app-stage')};
  });
  expect(rects.header.bottom).toBeLessThanOrEqual(rects.output.top+1);expect(rects.output.bottom).toBeLessThanOrEqual(rects.input.top+1);
  expect(rects.dialog.bottom).toBeLessThanOrEqual(rects.stage.bottom-12);expect(rects.dialog.right+12).toBeLessThan(rects.rail.left);
  await page.screenshot({path:info.outputPath(`terminal-${lang}-${size.width}.png`),caret:'initial'});
 }
 // Layout-only fixture: exercise wrapped output independently of model wording.
 await page.locator('.terminal-output-text').evaluate((el,text)=>{el.textContent=text;},lang==='en'?'I kept a little space for the things you wanted to tell me. '.repeat(4):lang==='ja'?'今日の小さな出来事も、ゆっくり聞かせてね。'.repeat(5):'今天遇到的小事也可以慢慢告诉我，我会在这里听你说。'.repeat(5));
 expect(await page.locator('.subtitle').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 const output=(await page.locator('.subtitle').boundingBox())!,row=(await page.locator('.input-row').boundingBox())!;
 expect(output.y+output.height).toBeLessThanOrEqual(row.y+1);
 await page.screenshot({path:info.outputPath(`terminal-long-${lang}.png`)});
 await page.locator('.phone-toggle').click();await expect(page.locator('.chat-page')).toHaveClass(/has-phone/);
 await page.locator('.dialog-reopen').click();await expect(page.locator('.chat-page')).not.toHaveClass(/has-phone/);
 await expect(page.locator('.input-row input')).toBeEditable();
 await page.setViewportSize({width:1440,height:900});
 await page.locator('[data-intro=chat-settings]').click();
 const preview=page.locator('.dialog-preview .dialog-box');await expect(preview).toBeVisible();
 await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
 await expect(preview.locator('.terminal-output-prompt')).toBeVisible();
 expect(await preview.evaluate(el=>getComputedStyle(el).borderRadius)).toBe('6px');
 await preview.scrollIntoViewIfNeeded();
 await page.screenshot({path:info.outputPath(`terminal-preview-${lang}.png`)});
});
