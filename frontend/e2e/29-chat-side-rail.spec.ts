import {test,expect} from './fixtures';
import {bootChat} from './helpers';

for(const lang of ['zh','en','ja'])test(`side rail stays fixed across phone and dialog states (${lang})`,async({page,request},info)=>{
 const state=await (await request.get('/api/state')).json();
 state.settings.general={...state.settings.general,lang,voiceInput:false};
 const failures:string[]=[];page.on('pageerror',error=>failures.push(error.message));
 await page.route('**/api/state',route=>route.fulfill({json:state}));
 await page.route('**/api/intro',route=>route.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await page.route('**/api/onboarding',route=>route.fulfill({json:{stage:'completed',configured:true}}));
 await page.route('**/api/meeting/**',route=>route.fulfill({json:{leaseId:'rail-fixture',epoch:1,expiresIn:60,activation:'active',focus:false,phonePaused:false,busy:false,activity:null,presentation:null}}));
 await page.route('**/api/phone?**',route=>route.fulfill({json:{apps:[{id:'momo-qq',provider:'qq',name:'QQ',enabled:true,pending:2}],accountKey:'fixture',pending:2,conversations:[{id:'20001',kind:'private',pending:2,preview:'A message'}],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null}}));
 await bootChat(page);
 const rail=page.locator('.chat-toolbar'),frame=rail.locator('.tb-framing');
 await expect(frame.locator('svg')).toHaveCount(1);
 expect((await frame.innerText()).trim()).toBe('');
 const initial=await frame.getAttribute('aria-label');
 await frame.click();await expect(frame).not.toHaveAttribute('aria-label',initial!);
 await frame.click();await expect(frame).toHaveAttribute('aria-label',initial!);
 for(const size of [{width:1440,height:900},{width:960,height:650},{width:800,height:450}]){
  await page.setViewportSize(size);
  await frame.hover();
  const tip=page.getByRole('tooltip',{name:initial!});await expect(tip).toBeVisible();
  const tipBox=await tip.boundingBox(),frameBox=await frame.boundingBox();
  expect(tipBox!.x+tipBox!.width).toBeLessThan(frameBox!.x);
  const before=await rail.boundingBox();
  await rail.locator('.phone-toggle').click();
  await expect(page.locator('.chat-page')).toHaveClass(/has-phone/);
  await page.evaluate(async()=>{await Promise.allSettled(document.querySelector('.dialog-drawer')!.getAnimations().map(a=>a.finished));});
  const after=await rail.boundingBox(),phone=await page.locator('.phone-surface').boundingBox(),stage=await page.locator('.app-stage').boundingBox();
  expect(after).toEqual(before);
  expect(phone!.x+phone!.width+12).toBeLessThan(after!.x);
  expect(after!.y).toBeGreaterThanOrEqual(stage!.y+8);
  expect(after!.y+after!.height).toBeLessThanOrEqual(stage!.y+stage!.height-8);
  await page.screenshot({path:info.outputPath(`phone-${size.width}.png`)});
  await page.locator('.dialog-reopen').click();
  await expect(page.locator('.chat-page')).not.toHaveClass(/has-phone/);
  await page.evaluate(async()=>{await Promise.allSettled(document.querySelector('.dialog-drawer')!.getAnimations().map(a=>a.finished));});
  const dialog=await page.locator('.dialog-box').boundingBox();
  expect(dialog!.x+dialog!.width+12).toBeLessThan(before!.x);
  expect(await rail.boundingBox()).toEqual(before);
  await page.screenshot({path:info.outputPath(`dialog-${size.width}.png`)});
 }
 expect(failures).toEqual([]);
});

test('help stays reachable when the pointer crosses the gap slowly',async({page})=>{
 await page.route('**/api/intro',route=>route.fulfill({json:{phase:'completed',languageConfirmed:true,configurationValid:true}}));
 await bootChat(page);
 const trigger=page.locator('.tb-focus');await trigger.hover();
 const bubble=page.locator('.tooltip-bubble'),help=bubble.locator('.tooltip-help');
 await expect(help).toBeVisible();
 const a=(await trigger.boundingBox())!,b=(await bubble.boundingBox())!;
 // Pause in the visible gap, rather than teleporting straight into the card.
 await page.mouse.move((a.x+b.x+b.width)/2,a.y+a.height/2);
 await page.waitForTimeout(450);
 await expect(bubble).toBeVisible();
 await help.hover();await help.click();
 await expect(bubble.locator('.tooltip-detail')).toBeVisible();
 await page.screenshot({path:'../target/tooltip-help-expanded.png'});
 await page.keyboard.press('Escape');await expect(bubble).toHaveCount(0);
 // Keyboard users can also move focus into the help without losing the card.
 await trigger.focus();await expect(help).toBeVisible();
 await help.focus();await page.keyboard.press('Enter');
 await expect(bubble.locator('.tooltip-detail')).toBeVisible();
 await page.mouse.move(20,20);await trigger.focus();
 await page.keyboard.press('Escape');await expect(bubble).toHaveCount(0);
 await trigger.hover();await expect(bubble).toBeVisible();
 await page.mouse.move(20,20);await expect(bubble).toHaveCount(0);
});
