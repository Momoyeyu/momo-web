import {test,expect} from './fixtures';
import {bootChat,readState,writeState,useStateRestore} from './helpers';

test.use({timezoneId:'America/New_York'});
test.afterEach(useStateRestore());

test('phone opens built-in memory notes even when the channel snapshot fails',async({page,request},info)=>{
 const state=await readState(request);
 const {general}=state.settings as {general:Record<string,unknown>};
 general.phonePresentation='closed';
 await writeState(request,state);
 let channelAvailable=false;
 await page.route('**/api/phone?**',r=>r.fulfill(channelAvailable?{json:{
  apps:[{id:'momo-qq',provider:'qq',name:'QQ',enabled:true,pending:0}],accountKey:'qq-fixture',
  pending:0,conversations:[],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null,
 }}:{status:503}));
 await page.route('**/api/memories',r=>r.fulfill({json:[
  {id:'note-old',content:'上一次写下的事。',createdAt:'2026-11-20T12:00:00Z',pinned:false},
  {id:'note-new',content:'记得一起去看了海。',createdAt:'2026-11-22T12:00:00Z',pinned:false},
 ]}));
 await bootChat(page);
 await page.locator('.phone-toggle').click();
 const phone=page.locator('.phone-surface');
 await expect(phone.getByRole('button',{name:'时钟',exact:true})).toBeVisible();
 await expect(phone.getByRole('button',{name:'QQ',exact:true})).toHaveCount(0);
 await phone.getByRole('button',{name:'记事本',exact:true}).click();
 await expect(phone.getByRole('heading',{name:'记事本'})).toBeVisible();
 await expect(phone.locator('.phone-notes p')).toHaveText(['记得一起去看了海。','上一次写下的事。']);
 await page.screenshot({path:info.outputPath('phone-notebook.png')});
 await phone.getByRole('button',{name:'返回',exact:true}).click();
 await expect(phone.getByRole('button',{name:'时钟',exact:true})).toBeVisible();
 channelAvailable=true;
 await expect(phone.locator('.phone-app')).toHaveText(['记事本','时钟','QQ']);
});

test('phone shows system time by default and persists its selected zone',async({page,request},info)=>{
 const state=await readState(request);
 const {general}=state.settings as {general:Record<string,unknown>};
 delete general.phoneTimeZone;
 general.phonePresentation='closed';
 await writeState(request,state);
 await page.clock.setFixedTime(new Date('2026-11-23T02:10:00Z'));
 await page.route('**/api/phone?**',r=>r.fulfill({json:{
  apps:[],accountKey:'',pending:0,conversations:[],messages:[],operations:[],hasMore:false,nextBefore:null,activity:null,
 }}));
 await bootChat(page);
 await page.locator('.phone-toggle').click();
 const phone=page.locator('.phone-surface');
 const statusTime=phone.locator('.phone-status-time');
 await expect(statusTime).toHaveText('21:10');
 await phone.getByRole('button',{name:'时钟',exact:true}).click();
 const zone=phone.getByLabel('时区',{exact:true});
 await expect(zone).toHaveValue('');
 await zone.selectOption('Asia/Shanghai');
 await expect(statusTime).toHaveText('10:10');
 await expect(phone.locator('.phone-clock-time')).toHaveText('10:10');
 await page.screenshot({path:info.outputPath('phone-clock.png')});
 await expect.poll(async()=>((await readState(request)).settings as {general:{phoneTimeZone?:string}}).general.phoneTimeZone).toBe('Asia/Shanghai');
 await page.reload();
 await expect(statusTime).toHaveText('10:10');
 await phone.getByRole('button',{name:'时钟',exact:true}).click();
 await zone.selectOption('');
 await expect(statusTime).toHaveText('21:10');
});
