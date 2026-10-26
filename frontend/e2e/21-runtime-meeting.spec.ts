import {bootChat} from './helpers';
import {test,expect} from './fixtures';
import './helpers';

test.beforeEach(()=>test.skip(process.env.MOMO_RUNTIME_SMOKE!=='1','Opt in: requires an explicitly isolated running Python/Cordis instance.'));

test('actual coordinator refuses a second window until the first leaves',async({page,context,request})=>{
  await bootChat(page);
  await expect(page.locator('.chat-page')).toBeVisible();
  await expect.poll(()=>page.locator('.chat-page').evaluate(element=>!element.closest('[inert]'))).toBe(true);
  await expect(page.locator('.meeting-gate')).toHaveCount(0);
  const other=await context.newPage();
  try {
    await other.goto('/#/chat');
    await expect(other.locator('.title-screen')).toBeVisible();
    await other.locator('.title-menu .menu-item').first().click();
    await expect(other.getByRole('alert')).toContainText('其他窗口正在使用 momo');
    await page.evaluate(()=>{location.hash='#/title';});
    await expect(page.locator('.title-screen')).toBeVisible();
    await expect.poll(async()=> (await (await request.get('/api/meeting')).json()).activation).toBe('dormant');
    await other.locator('.title-menu .menu-item').first().click();
    await expect(other.getByRole('alert')).toHaveCount(0);
    await expect.poll(()=>other.locator('.chat-page').evaluate(element=>!element.closest('[inert]'))).toBe(true);
  } finally {
    await other.evaluate(()=>{location.hash='#/title';}).catch(()=>{});
    await expect(other.locator('.title-screen')).toBeVisible();
    await other.close();
  }
});

test('actual unconfigured first meeting rejects an unusable API without saving it',async({page,request})=>{
  const state=await(await request.get('/api/state')).json();
  test.skip(Boolean(state.settings?.llm?.url),'Requires the fresh, unconfigured isolated profile.');
  await bootChat(page);
  const setup=page.locator('.first-meeting-setup');
  await expect(setup).toBeVisible();
  await setup.getByLabel('模型 API 地址',{exact:true}).fill('http://127.0.0.1:1');
  await setup.getByLabel('模型名称',{exact:true}).fill('invalid-model');
  await setup.getByRole('button',{name:'开始相遇',exact:true}).click();
  await expect(setup.getByRole('alert')).toContainText('连接未通过');
  await expect(setup).toBeVisible();
  expect((await(await request.get('/api/state')).json()).settings?.llm?.url??'').toBe('');
});

test('owned meeting survives refreshing backlog and settings without a new title entrance',async({page})=>{
  await bootChat(page);
  await expect.poll(()=>page.locator('.chat-page').evaluate(element=>!element.closest('[inert]'))).toBe(true);
  // A fresh unconfigured fixture has its setup portal; this case needs established chat.
  if(await page.locator('.first-meeting-setup').count())await page.locator('.first-meeting-setup').getByRole('button',{name:'取消',exact:true}).click();
  test.skip(await page.locator('.title-screen').count()>0,'Requires an established isolated profile.');
  const owner=()=>page.evaluate(()=>sessionStorage.getItem('momo.meeting-owner.v1'));
  for(const destination of ['记录','设置']){
    expect(await owner()).not.toBeNull();
    await page.getByRole('button',{name:destination,exact:true}).click();
    expect(await owner()).not.toBeNull();
    const restored=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/meeting/enter'&&response.status()===200);
    await page.reload();await restored;
    expect(await owner()).not.toBeNull();
    await page.getByRole('button',{name:'返回对话',exact:true}).click();
    await expect.poll(()=>page.locator('.chat-page').evaluate(element=>!element.closest('[inert]'))).toBe(true);
    await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  }
});
