import {test,expect} from './fixtures';
for(const lang of ['zh','en','ja'])for(const size of [{width:1280,height:720},{width:1920,height:1080}])test(`filled extension lists fit ${lang} ${size.width}`,async({page,request},info)=>{
 await page.setViewportSize(size);
 const state=await(await request.get('/api/state')).json();state.settings.general.lang=lang;
 state.settings.extensions=Array.from({length:17},(_,i)=>({name:`MCP ${i} 長い名前 测试 name`,enabled:false,transport:'http',endpoint:'https://example.com',headers:{},args:[],env:{},command:''}));
 const builtin=state.avatars.find((a:{id:string})=>a.id==='builtin');state.avatars=[builtin,...Array.from({length:16},(_,i)=>({...builtin,id:`fixture-${i}`,builtin:false,name:`Model ${i} 長い名前 测试 name`}))];
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.goto('/#/settings');await page.locator('.stab').nth(3).click();
 for(const tab of ['avatar','mcp','plugins']){
  await page.locator(`#extension-tab-${tab}`).click();await page.waitForTimeout(450);
  const panel=page.locator(`#extension-panel-${tab}`),pager=panel.locator('.list-pager');
  await expect(pager).toBeVisible();
  const bounds=await pager.boundingBox();expect(bounds!.y+bounds!.height).toBeLessThan(size.height-40);
  const overflow=await panel.evaluate(el=>{const viewport=el.closest('.settings-page')!;return {scroll:viewport.scrollHeight,client:viewport.clientHeight};});
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client+2);
  await page.screenshot({path:info.outputPath(`${tab}.png`)});
 }
});
