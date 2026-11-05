import {test,expect} from './fixtures';
import {bootChat} from './helpers';
test('room follows local time and keeps the existing avatar across lighting changes',async({page},info)=>{
 await page.setViewportSize({width:1280,height:720});
 await page.clock.setFixedTime(new Date(2026,10,5,8,0));
 await bootChat(page);
 const room=page.locator('.room-background');
 for(const [hour,phase] of [[8,'morning'],[12,'day'],[18,'evening'],[23,'night']] as const){
  await page.clock.setFixedTime(new Date(2026,10,5,hour,0));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(room).toHaveAttribute('data-room-phase',phase);
  await page.waitForTimeout(1500);
  await page.screenshot({path:info.outputPath(`room-${phase}.png`)});
  await expect(page.locator('.live2d-canvas')).toHaveCount(1);
 }
});
