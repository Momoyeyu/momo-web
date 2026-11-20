import {test, expect} from './fixtures';
import {bootChat, openTab} from './helpers';

test('a control action waits for both permissions and continues only when confirmed', async ({page, baseURL}) => {
  await page.addInitScript(base => {
    window.momoDesktop = {
      getRuntime: async () => ({baseUrl: base, token: 'isolated-permission-e2e'}),
      openPermissionGuide: async kind => { document.documentElement.dataset.requestedPermission = kind; },
      closePermissionGuide: async () => {},
      onPermissionGuideClosed: listener => {
        window.addEventListener('test:permission-guide-closed', listener);
        return () => window.removeEventListener('test:permission-guide-closed', listener);
      },
      setPermissionGuideGranted: async () => {},
    };
  }, baseURL!);
  let missing: ('screen'|'input')[] = [];
  let starts = 0;
  const windowTarget = {windowId: 7, ownerPid: 9, bundleId: 'fixture.browser', path: '/fixture', name: 'Fixture browser'};
  await page.route('**/api/computer/access', route => route.fulfill({json:{available:true, granted:true, blocked:[]}}));
  await page.route('**/api/computer/access/system', route => route.fulfill({json:{
    screenPermission: !missing.includes('screen'), inputPermission: !missing.includes('input'), applications:[],
  }}));
  await page.route('**/api/computer/access/precheck', route => route.fulfill({json:{missing}}));
  await page.route('**/api/extensions/activities', route => route.fulfill({json:{enabled:{computer:true,browser:true,minecraft:false}}}));
  await page.route('**/api/computer/native/targets', route => route.fulfill({json:{targets:[windowTarget],screenPermission:true,inputPermission:true}}));
  await page.route('**/api/computer/native/status', route => route.fulfill({json:{active:starts>0,plugin:'browser',target:starts>0?windowTarget:undefined}}));
  await page.route('**/api/computer/native/start', route => {
    starts++;
    expect(missing).toEqual([]);
    expect(route.request().postDataJSON()).toMatchObject({windowId:7,ownerPid:9,plugin:'browser'});
    return route.fulfill({json:{active:true,plugin:'browser',target:windowTarget}});
  });
  await bootChat(page);
  await openTab(page,'浏览器');
  const config = page.locator('#config-browser');
  await config.getByRole('button',{name:/^应用窗口 ·/}).click();
  await config.getByRole('option',{name:/Fixture browser/}).click();
  missing=['screen','input'];
  await config.getByRole('button',{name:'开启',exact:true}).click();
  const request = page.getByRole('dialog',{name:'授权后继续',exact:true});
  await expect(request.getByRole('button',{name:/去授权$/})).toHaveCount(2);
  await expect(request.getByRole('button',{name:'继续操作',exact:true})).toBeDisabled();
  expect(starts).toBe(0);

  for(const kind of ['screen','input'] as const){
    const label=kind==='screen'?'屏幕录制':'辅助功能';
    await request.getByRole('button',{name:/去授权/}).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-requested-permission',kind);
    missing=missing.filter(item=>item!==kind);
    await page.evaluate(()=>window.dispatchEvent(new Event('test:permission-guide-closed')));
    await expect(request.getByText(label,{exact:true})).toBeVisible();
    await expect(request.getByRole('button',{name:/已授权$/})).toHaveCount(kind==='screen'?1:2);
    if(kind==='screen')await expect(request.getByRole('button',{name:'继续操作',exact:true})).toBeDisabled();
    expect(starts).toBe(0);
  }
  missing=['screen'];
  await request.getByRole('button',{name:'继续操作',exact:true}).click();
  await expect(request.getByText('剩余 1 项授权',{exact:true})).toBeVisible();
  expect(starts).toBe(0);
  await request.getByRole('button',{name:/屏幕录制.*去授权/}).click();
  missing=[];
  await page.evaluate(()=>window.dispatchEvent(new Event('test:permission-guide-closed')));
  await expect(request.getByRole('button',{name:'继续操作',exact:true})).toBeEnabled();
  await request.getByRole('button',{name:'继续操作',exact:true}).click();
  await expect(request).toHaveCount(0);
  await expect.poll(()=>starts).toBe(1);
  await expect(config.getByText('已连接',{exact:true})).toBeVisible();
});
