import {test,expect} from './fixtures';
for(const lang of ['zh','en','ja'])for(const size of [{width:1280,height:720},{width:1920,height:1080}])test(`filled extension lists fit ${lang} ${size.width}`,async({page,request},info)=>{
 await page.setViewportSize(size);
 const state=await(await request.get('/api/state')).json();state.settings.general.lang=lang;
 state.settings.extensions=Array.from({length:17},(_,i)=>({name:`MCP ${i} 長い名前 测试 name`,enabled:false,transport:'http',endpoint:'https://example.com',headers:{},args:[],env:{},command:''}));
 const builtin=state.avatars.find((a:{id:string})=>a.id==='builtin');state.avatars=[builtin,...Array.from({length:16},(_,i)=>({...builtin,id:`fixture-${i}`,builtin:false,name:`Model ${i} 長い名前 测试 name`}))];
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.goto('/#/settings');
 for(const [section, row] of [['display', 'avatar'], ['tools', 'mcp']]){
  await page.locator('[aria-controls="config-'+section+'"]').click();
  if(section==='display')await page.locator('#config-display .config-action').click();
  const panel=page.locator(section==='display'?'.config-modal':'#config-tools .ext-panel'),pager=panel.locator('.list-pager');
  await expect(pager).toBeVisible();
  await pager.scrollIntoViewIfNeeded();
  await expect(pager).toBeInViewport();
  expect(await panel.evaluate(el=>el.scrollWidth)).toBeLessThanOrEqual(await panel.evaluate(el=>el.clientWidth)+2);
  if(section==='tools'){
   const searches=await page.locator('#config-tools input[type=search]').evaluateAll(inputs=>
    inputs.map(input=>{const box=input.getBoundingClientRect();return {top:box.top,height:box.height,left:box.left};}));
   expect(searches).toHaveLength(2);
   expect(searches[0].top).toBeCloseTo(searches[1].top,0);
   expect(searches[0].height).toBeCloseTo(searches[1].height,0);
   expect(searches[0].height).toBeLessThan(42);
   expect(searches[0].left).toBeLessThan(searches[1].left);
  }
  await page.screenshot({path:info.outputPath(row+'.png')});
  if(section==='display')await page.keyboard.press('Escape');
 }
});
