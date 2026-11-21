import {test,expect} from './fixtures';
for(const lang of ['zh','en','ja'])for(const size of [{width:1280,height:720},{width:1920,height:1080}])test(`filled extension lists fit ${lang} ${size.width}`,async({page,request},info)=>{
 await page.setViewportSize(size);
 const state=await(await request.get('/api/state')).json();state.settings.general.lang=lang;
 state.settings.extensions=Array.from({length:17},(_,i)=>({name:`MCP ${i} 長い名前 测试 name`,enabled:false,transport:'http',endpoint:'https://example.com',headers:{},args:[],env:{},command:''}));
 const builtin=state.avatars.find((a:{id:string})=>a.id==='builtin');state.avatars=[builtin,...Array.from({length:16},(_,i)=>({...builtin,id:`fixture-${i}`,builtin:false,name:`Model ${i} 長い名前 测试 name`}))];
 await page.route('**/api/state',r=>r.fulfill({json:state}));
 await page.goto('/#/settings');
 const section=page.locator('#config-customize');
 await page.locator('[aria-controls="config-customize"]').click();
 for(const row of ['avatar','mcp']){
  if(row==='avatar')await section.locator('.customize-library .icon-btn').first().click();
  const panel=row==='avatar'?page.locator('.config-modal'):section.locator('.ext-panel');
  const pager=panel.locator('.list-pager');
  await expect(pager).toBeVisible();
  await pager.scrollIntoViewIfNeeded();
  await expect(pager).toBeInViewport();
  expect(await panel.evaluate(el=>el.scrollWidth)).toBeLessThanOrEqual(await panel.evaluate(el=>el.clientWidth)+2);
  if(row==='mcp'){
   const search=panel.getByRole('searchbox');
   await expect(search).toHaveCount(1);
   await expect(panel.getByRole('heading',{name:'MCP',exact:true})).toBeVisible();
   await expect(panel.locator('.mcp-heading button')).toHaveCount(1);
   const box=(await search.boundingBox())!;
   expect(box.width).toBeLessThanOrEqual(156);
   expect(box.height).toBeLessThan(42);
  }
  await page.screenshot({path:info.outputPath(row+'.png')});
  if(row==='avatar')await page.keyboard.press('Escape');
 }
});
