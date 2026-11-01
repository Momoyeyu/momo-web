import {test,expect} from './fixtures';
import {bootChat} from './helpers';

test('the live phone itself reconstructs and dissolves, including interrupted transitions',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await page.route('**/api/phone?**',r=>r.fulfill({json:{apps:[{id:'momo-qq',provider:'qq',name:'QQ',enabled:true,pending:0}],accountKey:'fx',pending:0,conversations:[],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null}}));
 await bootChat(page);
 const effect=page.locator('.phone-surface .digital-materialize'),content=effect.locator('.digital-materialize-source');
 await expect(effect).toHaveAttribute('data-phase','hidden');
 await page.clock.install();await page.clock.pauseAt(new Date());
 const toggle=page.locator('.phone-toggle');await toggle.click();
 for(const [index,step] of [100,120,160,260].entries()){
  await page.clock.runFor(step);
  if(index<3){await expect(effect).toHaveAttribute('data-phase','appearing');expect(await content.evaluate(e=>getComputedStyle(e).filter)).toContain('url(');}
  await page.screenshot({path:info.outputPath(`appear-${index}.png`)});
 }
 await expect(effect).toHaveAttribute('data-phase','visible');
 expect(await content.evaluate(e=>getComputedStyle(e).filter)).toBe('none');
 await toggle.click();
 for(const [index,step] of [100,120,160,260].entries()){
  await page.clock.runFor(step);
  if(index<3){await expect(effect).toHaveAttribute('data-phase','disappearing');await expect(page.locator('.app-stage')).toHaveAttribute('data-phone-present','true');}
  await page.screenshot({path:info.outputPath(`disappear-${index}.png`)});
 }
 await expect(effect).toHaveAttribute('data-phase','hidden');
 await expect(page.locator('.app-stage')).toHaveAttribute('data-phone-present','false');
 await expect(content).toBeHidden();
 await toggle.click();await page.clock.runFor(220);await toggle.click();await page.clock.runFor(100);await toggle.click();await page.clock.runFor(700);
 await expect(effect).toHaveAttribute('data-phase','visible');
 await page.emulateMedia({reducedMotion:'reduce'});await toggle.click();
 await expect(effect).toHaveAttribute('data-phase','hidden');
 await toggle.click();await expect(effect).toHaveAttribute('data-phase','visible');
 expect(await content.evaluate(e=>getComputedStyle(e).filter)).toBe('none');
 await page.emulateMedia({reducedMotion:'no-preference'});await page.clock.resume();
 await page.getByRole('button',{name:'QQ',exact:true}).click();
 await expect(page.locator('.phone-app-title')).toHaveText('QQ');
 await page.evaluate(()=>{const scope=window as unknown as {mosaicPhases:string[]};scope.mosaicPhases=[];new MutationObserver(records=>{for(const record of records){if(record.target instanceof HTMLElement&&record.target.matches('.digital-materialize'))scope.mosaicPhases.push(record.target.dataset.phase??'');}}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-phase']});});
 for(const selector of ['[data-intro=chat-settings]','.chat-toolbar button[data-tip=记录]']){
  await page.locator(selector).click();
  await page.getByRole('button',{name:'返回对话',exact:true}).click();
  await expect(page.locator('.chat-page')).not.toHaveAttribute('inert');
  await expect(page.locator('.digital-materialize')).toHaveAttribute('data-phase','visible');
  expect(await page.locator('.digital-materialize-source').evaluate(e=>getComputedStyle(e).filter)).toBe('none');
  await expect(page.locator('.app-stage')).toHaveAttribute('data-phone-present','true');
  await expect(page.locator('.phone-app-title')).toHaveText('QQ');
 }
 const replayed=await page.evaluate(()=>(window as unknown as {mosaicPhases:string[]}).mosaicPhases.filter(p=>p==='appearing'||p==='disappearing'));
 expect(replayed).toEqual([]);
 expect(errors).toEqual([]);
});
