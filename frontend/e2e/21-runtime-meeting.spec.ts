import {test,expect} from '@playwright/test';
import './helpers';

test.beforeEach(()=>test.skip(process.env.MOMO_RUNTIME_SMOKE!=='1','Opt in: requires an explicitly isolated running Python/Cordis instance.'));

test('actual coordinator refuses a second window until the first leaves',async({page,context})=>{
  await page.goto('/#/chat');
  await expect(page.locator('.chat-page')).toBeVisible();
  await expect.poll(()=>page.locator('.chat-page').evaluate(element=>!element.closest('[inert]'))).toBe(true);
  await expect(page.locator('.meeting-gate')).toHaveCount(0);
  const other=await context.newPage();
  try {
    await other.goto('/#/chat');
    await expect(other.locator('.meeting-gate')).toContainText('请先关闭其他已进入见面的窗口');
    await page.evaluate(()=>{location.hash='#/title';});
    await expect(page.locator('.title-screen')).toBeVisible();
    await other.locator('.meeting-gate').getByRole('button',{name:'重试',exact:true}).click();
    await expect(other.locator('.meeting-gate')).toHaveCount(0);
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
  await page.goto('/#/chat');
  const setup=page.locator('.first-meeting-setup');
  await expect(setup).toBeVisible();
  await setup.getByLabel('模型 API 地址',{exact:true}).fill('http://127.0.0.1:1');
  await setup.getByLabel('模型名称',{exact:true}).fill('invalid-model');
  await setup.getByRole('button',{name:'开始相遇',exact:true}).click();
  await expect(setup.getByRole('alert')).toContainText('连接未通过');
  await expect(setup).toBeVisible();
  expect((await(await request.get('/api/state')).json()).settings?.llm?.url??'').toBe('');
});
