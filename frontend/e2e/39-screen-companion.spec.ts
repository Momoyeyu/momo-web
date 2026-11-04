import {test,expect} from './fixtures';
import {bootChat,openExtensionTab,gotoRoute} from './helpers';
test('screen capture survives settings navigation and explicit stop releases its tracks',async({page})=>{
 let observing=false,frames=0;
 await page.addInitScript(()=>{
  Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{value:async()=>{
   const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
   const context=canvas.getContext('2d')!;context.fillStyle='#e9c476';context.fillRect(0,0,320,180);
   const stream=canvas.captureStream(1);
   (window as unknown as {fixtureScreen:MediaStream}).fixtureScreen=stream;
   return stream;
  }});
 });
 await page.route('**/api/computer/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/start'))observing=true;
  if(path.endsWith('/stop'))observing=false;
  if(path.endsWith('/frames')){
   const body=route.request().postDataBuffer();expect(body?.includes(Buffer.from([0xff,0xd8]))).toBe(true);frames++;
  }
  await route.fulfill({json:{observing,generation:23,proactive:false,reactions:false}});
 });
 await bootChat(page);await openExtensionTab(page,'插件');
 await page.getByRole('button',{name:'选择共享画面',exact:true}).click();
 await expect.poll(()=>frames).toBeGreaterThan(0);
 await gotoRoute(page,'chat');
 const before=frames;await expect.poll(()=>frames).toBeGreaterThan(before);
 await openExtensionTab(page,'插件');
 await page.getByRole('button',{name:'停止观察',exact:true}).click();
 await expect.poll(()=>observing).toBe(false);
 expect(await page.evaluate(()=>(window as unknown as {fixtureScreen:MediaStream}).fixtureScreen.getTracks().every(track=>track.readyState==='ended'))).toBe(true);
});
