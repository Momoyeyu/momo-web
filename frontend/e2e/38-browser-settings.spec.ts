import {test,expect} from './fixtures';
import {bootChat,openTab} from './helpers';

test('desktop and browser have independent consent switches without window setup or background capture',async({page,baseURL})=>{
 await page.setViewportSize({width:1280,height:720});
 await page.addInitScript(base=>{
  window.momoDesktop={getRuntime:async()=>({baseUrl:base,token:'operations-fixture'})};
 },baseURL!);
 let granted=false,browserGranted=false,reads=0;
 const policy=()=>({available:true,granted,browserGranted,blocked:[]});
 await page.route('**/api/computer/access',r=>r.fulfill({json:policy()}));
 await page.route('**/api/computer/access/consent',r=>{
  const body=r.request().postDataJSON();
  if(body.plugin==='browser')browserGranted=body.granted;
  else granted=body.granted;
  return r.fulfill({json:policy()});
 });
 await page.route('**/api/computer/access/system',r=>r.fulfill({json:{screenPermission:true,inputPermission:true,applications:[]}}));
 await page.route('**/api/computer/status',r=>r.fulfill({json:{proactive:true,reactions:true,desktopAccessGranted:granted}}));
 await page.route(/\/api\/computer\/(native\/(targets|start|frame)|desktop\/frame)$/,r=>{
  reads++;
  return r.fulfill({json:{}});
 });
 await openTab(page,'操作');
 const panel=page.locator('#config-operations');
 const desktop=panel.getByRole('switch',{name:'桌面访问',exact:true});
 const browser=panel.getByRole('switch',{name:'浏览器访问',exact:true});
 const rows=panel.locator('.opt-row');
 await expect(rows).toHaveCount(4,{timeout:2000});
 await expect(panel.getByText('应用黑名单',{exact:true})).toHaveCount(0);
 const [desktopRow,browserRow,recordingRow,accessibilityRow]=await Promise.all((await rows.all()).map(row=>row.boundingBox()));
 expect(desktopRow!.x).toBeCloseTo(browserRow!.x,0);
 expect(recordingRow!.x).toBeCloseTo(accessibilityRow!.x,0);
 expect(desktopRow!.x+desktopRow!.width).toBeLessThan(recordingRow!.x);
 expect(desktopRow!.y).toBeCloseTo(recordingRow!.y,0);
 expect(browserRow!.y).toBeCloseTo(accessibilityRow!.y,0);
 await expect(panel.getByRole('switch')).toHaveCount(2);
 await expect(panel.locator('.sel-face')).toHaveCount(0);
 await expect(panel.getByRole('button',{name:'桌面陪伴'})).toHaveCount(0);
 await expect(panel).not.toContainText('未连接');
 await expect(desktop).toHaveAttribute('aria-checked','false');
 await browser.click();
 await expect(browser).toHaveAttribute('aria-checked','true');
 await expect(desktop).toHaveAttribute('aria-checked','false');
 await desktop.click();
 await browser.click();
 await expect(browser).toHaveAttribute('aria-checked','false');
 await expect(desktop).toHaveAttribute('aria-checked','true');
 await page.reload();
 await openTab(page,'操作');
 await expect(desktop).toHaveAttribute('aria-checked','true');
 await expect(browser).toHaveAttribute('aria-checked','false');
 await bootChat(page);
 await expect(page.getByRole('button',{name:'主动回应',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.waitForTimeout(2800);
 expect(reads).toBe(0);
});
