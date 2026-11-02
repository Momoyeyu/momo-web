import {test,expect} from './fixtures';
import {bootChat,waitForChatReady} from './helpers';

for(const destination of ['设置','记录'])test(`chat to ${destination} keeps the avatar underneath and pauses speech`,async({page},info)=>{
 await page.route('**/api/intro',r=>r.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await page.route('**/api/meeting**',r=>r.fulfill({json:{leaseId:'layer-fixture',epoch:1,expiresIn:3600,activation:'active',focus:false,phonePaused:false,busy:false,activity:null,presentation:null}}));
 await bootChat(page);
 await page.evaluate(async()=>{
  const entry=performance.getEntriesByType('resource').find(e=>e.name.includes('/src/chat/engineInstance.ts'))!;
  const engine=(await import(entry.name)).getChatEngine();
  const scope=window as unknown as {avatarNode:HTMLCanvasElement;hiddenFrames:number;audioPauses:boolean[];watchLayers:boolean};
  scope.avatarNode=document.querySelector('.live2d-canvas')!;scope.hiddenFrames=0;scope.audioPauses=[];scope.watchLayers=true;
  const original=engine.player.setPaused;
  engine.player.setPaused=function(paused:boolean){scope.audioPauses.push(paused);return original.call(this,paused);};
  const sample=()=>{if(!scope.watchLayers)return;if(getComputedStyle(scope.avatarNode).opacity!=='1')scope.hiddenFrames++;requestAnimationFrame(sample);};requestAnimationFrame(sample);
 });
 await page.getByRole('button',{name:destination,exact:true}).click();
 await expect(page.locator('.page-wrap.is-front')).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {audioPauses:boolean[]}).audioPauses.includes(true))).toBe(true);
 await page.screenshot({path:info.outputPath('covered-scene.png')});
 await expect(page.locator('.page-wrap.is-front')).toHaveCount(0);
 const covered=await page.evaluate(()=>{const s=window as unknown as {avatarNode:HTMLCanvasElement;hiddenFrames:number};return {hidden:s.hiddenFrames,same:s.avatarNode===document.querySelector('.live2d-canvas'),opacity:getComputedStyle(s.avatarNode).opacity,pointer:getComputedStyle(s.avatarNode).pointerEvents};});
 expect(covered.hidden).toBe(0);expect(covered.same).toBe(true);expect(covered.opacity).toBe('1');expect(covered.pointer).toBe('none');
 await page.getByRole('button',{name:'返回对话',exact:true}).click();
 await waitForChatReady(page);
 const returned=await page.evaluate(()=>{const s=window as unknown as {avatarNode:HTMLCanvasElement;hiddenFrames:number;watchLayers:boolean};s.watchLayers=false;return {hidden:s.hiddenFrames,same:s.avatarNode===document.querySelector('.live2d-canvas'),pointer:getComputedStyle(s.avatarNode).pointerEvents};});
 expect(returned.hidden).toBe(0);expect(returned.same).toBe(true);expect(returned.pointer).toBe('auto');
});
