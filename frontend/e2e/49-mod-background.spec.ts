import {test,expect} from './fixtures';
import {openTab} from './helpers';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iXioAAAAASUVORK5CYII=','base64');

test('room restores built-in lighting as soon as a background is disabled and a failed replacement stays hidden',async({page})=>{
  let enabled=false;
  const id='example.room';
  const path='room.png';
  const url=`/api/mods/${id}/assets/${path}?v=test`;
  const record=()=>({id,name:'Fixture room',kind:'content',source:'local',platforms:['*'],enabled,version:'1.0.0',resources:[{type:'background',path,url}]});
  await page.route('**/api/mods',route=>route.fulfill({json:{mods:[record()]}}));
  await page.route(`**/api/mods/${id}`,async route=>{
    enabled=route.request().postDataJSON().enabled;
    await route.fulfill({json:record()});
  });
  let release: (()=>void)|undefined;
  let reads=0;
  await page.route('**/assets/room.png?*',async route=>{
    if(++reads===2){
      await new Promise<void>(resolve=>{release=resolve;});
      await route.fulfill({contentType:'image/png',body:'unreadable image'});
    }else await route.fulfill({contentType:'image/png',body:png});
  });
  await openTab(page,'模组');
  await page.locator('#config-mods .opt-row').filter({hasText:'Fixture room'}).getByRole('button',{name:'配置模组'}).click();
  const dialog=page.getByRole('dialog',{name:'Fixture room'});
  const art=page.locator('[data-mod-background]');
  const enable=dialog.getByRole('button',{name:'启用模组'});
  const disable=dialog.getByRole('button',{name:'停用模组'});
  await enable.click();await expect(art).toHaveCount(1);
  const original=await art.evaluate(el=>getComputedStyle(el).backgroundImage);
  await disable.click();await expect(art).toHaveCount(0);
  await enable.click();
  await expect.poll(()=>Boolean(release)).toBe(true);
  await expect(art).toHaveCount(0);
  const result=page.waitForResponse(response=>response.url().endsWith(url));
  release!();await result;
  await expect(page.locator('.room-lighting').first()).toBeAttached();
  await expect(art).toHaveCount(0);
  await disable.click();await enable.click();await expect(art).toHaveCount(1);
  expect(await art.evaluate(el=>getComputedStyle(el).backgroundImage)).not.toBe(original);
});

test('a confirmed disable withdraws the background even if the following catalog read fails',async({page})=>{
  let enabled=true;
  const id='example.room';
  const url='/api/mods/example.room/assets/room.png?v=known';
  const record=()=>({id,name:'Fixture room',kind:'content',source:'local',platforms:['*'],enabled,version:'1.0.0',resources:[{type:'background',path:'room.png',url}]});
  await page.route('**/api/mods',route=>enabled ? route.fulfill({json:{mods:[record()]}}) : route.fulfill({status:503}));
  await page.route('**/api/mods/example.room',async route=>{enabled=false;await route.fulfill({json:record()});});
  await page.route('**/assets/room.png?*',route=>route.fulfill({contentType:'image/png',body:png}));
  await openTab(page,'模组');
  const art=page.locator('[data-mod-background]');
  await expect(art).toHaveCount(1);
  await page.locator('#config-mods .opt-row').filter({hasText:'Fixture room'}).getByRole('button',{name:'配置模组'}).click();
  await page.getByRole('dialog',{name:'Fixture room'}).getByRole('button',{name:'停用模组'}).click();
  await expect(page.locator('#config-mods').getByRole('alert')).toBeVisible();
  await expect(art).toHaveCount(0);
});

test('an open companion window follows a confirmed background change in settings',async({page,context})=>{
  let enabled=true;
  const id='example.room';
  const url='/api/mods/example.room/assets/room.png?v=shared';
  const record=()=>({id,name:'Fixture room',kind:'content',source:'local',platforms:['*'],enabled,version:'1.0.0',resources:[{type:'background',path:'room.png',url}]});
  await context.route('**/api/mods',route=>route.fulfill({json:{mods:[record()]}}));
  await context.route('**/api/mods/example.room',async route=>{enabled=false;await route.fulfill({json:record()});});
  await context.route('**/assets/room.png?*',route=>route.fulfill({contentType:'image/png',body:png}));
  const companion=await context.newPage();
  try{
    await companion.goto('/#/title');
    const art=companion.locator('[data-mod-background]');
    await expect(art).toHaveCount(1);
    await openTab(page,'模组');
    await page.locator('#config-mods .opt-row').filter({hasText:'Fixture room'}).getByRole('button',{name:'配置模组'}).click();
    await page.getByRole('dialog',{name:'Fixture room'}).getByRole('button',{name:'停用模组'}).click();
    await expect(art).toHaveCount(0);
  }finally{await companion.close();}
});
