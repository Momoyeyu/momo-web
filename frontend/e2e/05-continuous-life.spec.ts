import {test,expect,type Page} from './fixtures';
import {settle,waitForChatReady} from './helpers';

async function continuousLife(page:Page) {
  const rows=Array.from({length:250},(_,index)=>({eventId:`event-${index+1}`,seq:index+1,runId:`run-${Math.floor(index/2)}`,source:'meeting',externalMessageId:null,role:index%2?'assistant':'user',text:`moment-${index+1}`,at:'2026-10-25T10:00:00Z'}));
  const forbidden:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/checkpoints')&&request.method()!=='GET')forbidden.push(request.url());});
  await page.route('**/api/state',route=>route.fulfill({json:{settings:{general:{lang:'zh',voiceInput:false},llm:{url:'https://fixture.test',model:'fixture',key:''},tts:{url:'',key:'',voice:'',prompt:''}}}}));
  await page.route('**/api/onboarding',route=>route.fulfill({json:{stage:'completed',configured:true}}));
  await page.route('**/api/meeting/**',route=>route.fulfill(route.request().url().endsWith('/leave')?{status:204}:{json:{leaseId:'fixture-lease',epoch:1,expiresIn:60}}));
  await page.route('**/api/life/history**',route=>{
    const before=Number(new URL(route.request().url()).searchParams.get('before')||Number.MAX_SAFE_INTEGER);
    const available=rows.filter(row=>row.seq<before),messages=available.slice(-100);
    return route.fulfill({json:{messages,hasMore:available.length>100,nextBefore:messages[0]?.seq??null}});
  });
  return {forbidden,rows};
}

test('title meets the same momo without save slots or a new-session request',async({page})=>{
  const {forbidden}=await continuousLife(page);
  await page.goto('/#/title');
  await expect(page.locator('.title-menu .mi-label')).toHaveText(['继续相处','设置']);
  await page.getByRole('button',{name:'继续相处 meet'}).click();
  await waitForChatReady(page);
  await expect(page.locator('.subtitle')).toHaveText('moment-250');
  await expect(page.getByRole('button',{name:/^(存档|读档)$/})).toHaveCount(0);
  await page.getByRole('button',{name:'返回标题',exact:true}).click();
  await expect(page.locator('.title-screen')).toBeVisible();
  await page.getByRole('button',{name:'继续相处 meet'}).click();
  await waitForChatReady(page);
  await expect(page.locator('.subtitle')).toHaveText('moment-250');
  expect(forbidden).toEqual([]);
});

test('paged backlog reaches older than 100 messages without duplicate events',async({page})=>{
  await continuousLife(page);
  await page.goto('/#/backlog');
  await settle(page);
  await expect(page.locator('.bl-item')).toHaveCount(100);
  await page.getByRole('button',{name:'更早的记录',exact:true}).click();
  await expect(page.locator('.bl-item')).toHaveCount(200);
  await page.getByRole('button',{name:'更早的记录',exact:true}).click();
  await expect(page.locator('.bl-item')).toHaveCount(250);
  await expect(page.locator('.bl-text').first()).toHaveText('moment-1');
  await expect(page.getByRole('button',{name:'更早的记录',exact:true})).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.bl-item')).toHaveCount(100);
});

test('legacy checkpoint link returns to the continuous-life title',async({page})=>{
  await continuousLife(page);
  await page.goto('/#/checkpoint');
  await expect(page.locator('.title-screen')).toBeVisible();
  await expect(page.locator('.checkpoint-page')).toHaveCount(0);
});

test('an unavailable owner keeps meeting input gated until the player leaves',async({page})=>{
  await continuousLife(page);
  await page.route('**/api/meeting/enter',route=>route.fulfill({status:409,json:{detail:'meeting_owned'}}));
  const chats:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/chat')chats.push(request.url());});
  await page.goto('/#/chat');
  await expect(page.locator('.meeting-gate')).toContainText('请先关闭其他已进入见面的窗口');
  await expect.poll(()=>page.locator('.chat-page').evaluate(element=>!!element.closest('[inert]'))).toBe(true);
  expect(chats).toEqual([]);
  await page.locator('.meeting-gate').getByRole('button',{name:'返回标题',exact:true}).click();
  await expect(page.locator('.title-screen')).toBeVisible();
  await expect(page.locator('.meeting-gate')).toHaveCount(0);
});

test('a failed initial history page can be retried without leaving the backlog',async({page})=>{
  await continuousLife(page);
  let failures=0;
  await page.route('**/api/life/history**',route=>failures++<2?route.fulfill({status:503,json:{detail:'temporary'}}):route.fallback());
  await page.goto('/#/backlog');
  await expect(page.locator('.backlog-list [role=alert]')).toBeVisible();
  await page.locator('.backlog-list').getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.locator('.bl-item')).toHaveCount(100);
  await expect(page.locator('.backlog-list [role=alert]')).toHaveCount(0);
});

test('settings pauses actual presentation and ACK, then resumes that reply without a new title entry',async({page})=>{
  await continuousLife(page);
  await page.route('**/api/state',route=>route.fulfill({json:{settings:{general:{lang:'zh',voiceInput:false,textSpeed:0,sentenceSpeed:100},llm:{url:'https://fixture.test',model:'fixture',key:''},tts:{url:'',key:'',voice:'',prompt:''}}}}));
  const seen:string[]=[];
  await page.route('**/api/life/ack',route=>{seen.push(route.request().postDataJSON().text);return route.fulfill({json:{ok:true}});});
  await page.route('**/api/chat/interrupt',route=>route.fulfill({status:204}));
  const text='这是一段会慢慢说完的话。'.repeat(10);
  await page.route('**/api/chat',route=>route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify({t:'sentence',no:0,text,cues:[],at:'t',runId:'pause-run',eventId:'pause-reply',seq:252,userEventId:'pause-user',userSeq:251,generation:3})}\n\ndata: {"t":"done"}\n\n`}));
  await page.goto('/#/chat');await waitForChatReady(page);
  await page.locator('.input-row input').fill('慢慢说');await page.locator('.input-row input').press('Enter');
  await expect.poll(()=>seen.length).toBeGreaterThan(0);
  await page.getByRole('button',{name:'设置',exact:true}).click();await settle(page);
  const paused=seen.at(-1)!;await page.waitForTimeout(500);
  expect(seen.at(-1)).toBe(paused);
  await page.getByRole('button',{name:'返回对话',exact:true}).click();await waitForChatReady(page);
  await expect.poll(()=>seen.at(-1)?.length??0).toBeGreaterThan(paused.length);
  await expect(page.locator('.chat-entry-canvas')).toHaveCount(0);
  await page.getByRole('button',{name:'打断',exact:true}).click();
});


test('fresh meetings synchronize other-entry history while subpage returns keep the current projection',async({page})=>{
  const {rows}=await continuousLife(page);
  let reads=0;
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/life/history')reads++;});
  await page.goto('/#/chat');await waitForChatReady(page);
  await expect(page.locator('.subtitle')).toHaveText('moment-250');
  const initialReads=reads;
  await page.getByRole('button',{name:'设置',exact:true}).click();await settle(page);
  await page.getByRole('button',{name:'返回对话',exact:true}).click();await waitForChatReady(page);
  expect(reads).toBe(initialReads);
  await page.getByRole('button',{name:'返回标题',exact:true}).click();
  await expect(page.locator('.title-screen')).toBeVisible();
  rows.push({...rows.at(-1)!,eventId:'other-entry',seq:251,runId:'other-run',source:'virtual',text:'从另一个入口延续的问候。'});
  await page.getByRole('button',{name:'继续相处 meet'}).click();await waitForChatReady(page);
  await expect(page.locator('.subtitle')).toHaveText('从另一个入口延续的问候。');
  expect(reads).toBe(initialReads+1);
});
