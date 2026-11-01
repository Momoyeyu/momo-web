import {test,expect} from './fixtures';
import {bootChat} from './helpers';
import {writeFile} from 'node:fs/promises';

test('records real frame pacing with slow phone data',async({page},info)=>{
 await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await page.route('**/api/phone?**',async r=>{await new Promise(resolve=>setTimeout(resolve,800));await r.fulfill({json:{apps:[],accountKey:'pacing',pending:0,conversations:[],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null}});});
 await page.addInitScript(()=>{const scope=window as unknown as {playbackEncodes:number};scope.playbackEncodes=0;const original=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...args){if(['appearing','disappearing'].includes(document.querySelector('.digital-materialize')?.getAttribute('data-phase')??''))scope.playbackEncodes++;return original.apply(this,args);};});
 await bootChat(page);
 await page.evaluate(()=>{const scope=window as unknown as {pacing:Record<string,number[]>};scope.pacing={};let previous=0,phase='';const tick=(now:number)=>{const next=document.querySelector('.digital-materialize')?.getAttribute('data-phase')??'';if(next===phase&&(phase==='appearing'||phase==='disappearing'))(scope.pacing[phase]??=[]).push(now-previous);previous=now;phase=next;requestAnimationFrame(tick);};requestAnimationFrame(tick);});
 const fx=page.locator('.digital-materialize'),toggle=page.locator('.phone-toggle');
 await toggle.click();await expect(fx).toHaveAttribute('data-phase','visible');
 await toggle.click();await expect(fx).toHaveAttribute('data-phase','hidden');
 const result=await page.evaluate(()=>(window as unknown as {pacing:Record<string,number[]>}).pacing);
 await writeFile(info.outputPath('pacing.json'),JSON.stringify(result,null,2));
 expect(await page.evaluate(()=>(window as unknown as {playbackEncodes:number}).playbackEncodes)).toBe(0);
 for(const frames of Object.values(result))expect(frames.length).toBeGreaterThan(3);
});
