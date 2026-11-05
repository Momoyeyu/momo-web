import {test,expect} from './fixtures';
import {openExtensionTab} from './helpers';
test('plugin library searches, pages, and requires trust before enabling imported code',async({page},testInfo)=>{
 const plugins=Array.from({length:11},(_,i)=>({manifest:{id:`sample-${i}`,name:`Sample ${String(i).padStart(2,'0')}`,version:'1.0.0',description:'A long plugin description for layout validation.',capabilities:['screen.observe']},enabled:false}));
 let enabled=false;
 await page.route('**/api/extensions/plugins**',async route=>{
  if(route.request().method()==='PATCH'){enabled=true;await route.fulfill({json:{ok:true}});return;}
  await route.fulfill({json:{plugins}});
 });
 await openExtensionTab(page,'插件');
 const library=page.locator('.plugin-library');
 await expect(library.locator('.plugin-library-card')).toHaveCount(3);
 await library.locator('.pager-btn').last().click();
 await expect(library.locator('.plugin-library-card')).toHaveCount(4);
 await page.screenshot({path:testInfo.outputPath('plugin-library.png')});
 await library.locator('.list-search').fill('Sample 10');
 await expect(library.locator('.plugin-library-card')).toHaveCount(1);
 await library.locator('.plugin-library-card button').first().click();
 await expect(page.getByRole('dialog')).toContainText('权限声明不是沙箱');
 expect(enabled).toBe(false);
 await page.getByRole('button',{name:'信任并启用'}).click();
 await expect.poll(()=>enabled).toBe(true);
});
