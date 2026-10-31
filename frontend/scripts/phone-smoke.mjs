import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const out=new URL('../../.autodev/runs/v3-011/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});
const failures=[];page.on('pageerror',e=>failures.push(e.message));
const scenario=process.argv[2];
const data={apps:[{id:'momo-qq',provider:'qq',name:'QQ',enabled:true,pending:2}],accountKey:'test',pending:2,conversations:[{id:'20001',kind:'private',pending:2,preview:'https://example.com/'+('unbroken'.repeat(60))}],messages:[{id:'a',text:'A long garden message. '.repeat(80),direction:'in',speaker:'20001',status:'held_focus',at:'now'},{id:'b',text:'We can bring tea.',direction:'out',speaker:'momo',status:'delivered',at:'now'}],operations:[],hasMore:false,nextBefore:null,activity:null};
await page.route('**/api/**',route=>route.fulfill({json:data}));
await page.route('**/phone-fixture.html',route=>route.fulfill({contentType:'text/html',body:`<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div>
<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>
<script type="module">
import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';const {createRoot}=ReactDOM;
import Drawer from '/src/phone/DialogDrawer.tsx';import Box from '/src/components/DialogBox.tsx';import Handle from '/src/phone/DialogHandle.tsx';import Phone from '/src/components/PhoneSurface.tsx';import Tooltips from '/src/ui/TooltipLayer.tsx';import Button from '/src/ui/Button.tsx';import Icon from '/src/ui/Icon.tsx';import '/src/styles/base.css';import '/src/styles/chat.css';
const root=createRoot(document.getElementById('root'));let closeSignal=0;window.closePhone=()=>{closeSignal++;render()};let a={activation:'active',focus:true,phonePaused:false,busy:false,activity:null,presentation:null};
window.updatePhone=s=>{a={...a,...s};render()};
function render(){root.render(React.createElement('div',{className:'app-stage',style:{width:'100vw',height:'100vh',background:'var(--bg)'}},React.createElement('div',{className:'live2d-home'}),React.createElement('div',{className:'chat-page'},React.createElement(Drawer,null,React.createElement('div',{className:'dialog-zone'},React.createElement(Box,{name:'momo',text:'A shared panel returns along its original path.',handle:React.createElement(Handle,{onClick:()=>window.closePhone()})},React.createElement('input',{placeholder:'Chat'})))),React.createElement('div',{className:'chat-toolbar'},React.createElement('div',{className:'tb-side'},React.createElement(Button,{className:'tb', 'data-tip':'专注对话','data-tip-detail':'暂时不处理手机消息','aria-label':'专注对话'},React.createElement(Icon,{name:'focus'})),React.createElement(Phone,{active:true,attention:a,closeSignal,onVisibilityChange:show=>document.querySelector('.chat-page')?.classList.toggle('has-phone',show)})))),React.createElement(Tooltips)))}render();
</script></body></html>`}));
try{
 if(scenario==='disabled')data.apps[0].enabled=false;
 if(scenario==='layout'){data.conversations[0].id='group:20001234567890123456';data.conversations[0].kind='group';data.hasMore=true;data.nextBefore=1;data.operations=[{id:'failed-long',status:'failed',action:'groups.manage.longOperationName'}];}
 await page.goto('http://127.0.0.1:5177/phone-fixture.html');
 const toggle=page.getByRole('button',{name:'手机',exact:true});await toggle.waitFor();
 if(await toggle.getAttribute('aria-expanded')!=='false')throw Error('Phone must start closed');
 if(scenario==='layout'){
  const checks=[];
  for(const size of [{width:1280,height:800},{width:960,height:650},{width:1920,height:1080}])for(const lang of ['zh','en','ja']){
   await page.setViewportSize(size);
   await page.evaluate(async lang=>{const store=await import('/src/lib/store.ts');store.update({settings:{...store.getSettings(),general:{...store.getSettings().general,lang}}});},lang);
   if(await page.locator('.phone-toggle').getAttribute('aria-expanded')==='false')await page.locator('.phone-toggle').click();
   await page.locator('.phone-home-bar').click();await page.locator('.phone-app').waitFor();
   await page.waitForFunction(()=>document.querySelector('.phone-glass').getAnimations().every(a=>a.playState==='finished'));
   await page.waitForFunction(()=>document.querySelector('.dialog-drawer').getAnimations().every(a=>a.playState==='finished'));
   const metrics=await page.evaluate(()=>{
    const box=el=>el.getBoundingClientRect();const phone=box(document.querySelector('.phone-surface')),tile=document.querySelector('.phone-app'),icon=box(tile.querySelector('.phone-app-icon')),label=box(tile.lastElementChild),handle=box(document.querySelector('.dialog-reopen'));
    return {phoneTop:phone.top,phoneBottom:phone.bottom,stageScroll:document.querySelector('.app-stage').scrollTop,ratio:phone.height/phone.width,inside:phone.top>=0&&phone.bottom<=innerHeight,centers:Math.abs(icon.x+icon.width/2-label.x-label.width/2),handleCenter:Math.abs(handle.x+handle.width/2-innerWidth/2),handleBottom:innerHeight-handle.bottom,overflow:document.querySelector('.phone-home').scrollWidth>document.querySelector('.phone-home').clientWidth+1};
   });
   if(Math.abs(metrics.ratio-19.5/9)>.03||!metrics.inside||metrics.centers>1||metrics.handleCenter>1||metrics.handleBottom>12||metrics.overflow)throw Error(JSON.stringify(metrics));
   await page.waitForFunction(()=>document.querySelector('.dialog-drawer').getAnimations().every(a=>a.playState==='finished'));
   await page.screenshot({path:new URL(`layout-${lang}-${size.width}.png`,out).pathname});
   await page.locator('.phone-app').click();
   const listBox=await page.locator('.phone-surface').boundingBox();
   if(Math.abs(listBox.height/listBox.width-19.5/9)>.03)throw Error('QQ list broke phone ratio');
   await page.getByRole('button',{name:/20001/}).click();
   await page.getByText('We can bring tea.',{exact:true}).waitFor();
   const messageBox=await page.locator('.phone-surface').boundingBox();if(Math.abs(messageBox.height/messageBox.width-19.5/9)>.03)throw Error('QQ messages broke phone ratio');
   const title=await page.locator('.phone-app-title').boundingBox(),back=await page.locator('.phone-app-header .phone-nav').boundingBox();
   if(back.x+back.width>title.x)throw Error('Header overlaps');
   if(await page.locator('.phone-scroll').evaluate(el=>el.scrollWidth>el.clientWidth+1))throw Error('Messages overflow horizontally');
   const button=await page.locator('.phone-earlier').boundingBox(),screen=await page.locator('.phone-scroll').boundingBox();
   if(Math.abs(button.x+button.width/2-screen.x-screen.width/2)>2)throw Error('Earlier control is off axis');
   await page.locator('.dialog-reopen').click();
   await page.waitForFunction(()=>{const opacity=+getComputedStyle(document.querySelector('.phone-surface')).opacity;return opacity>0&&opacity<1;});
   const drawerMotion=await page.locator('.dialog-drawer').evaluate(el=>el.getAnimations().some(a=>a.playState==='running'));if(!drawerMotion)throw Error('Dialog must pull out continuously');
   await page.screenshot({path:new URL(`close-mid-${lang}-${size.width}.png`,out).pathname});
   await page.waitForFunction(()=>document.querySelector('.phone-toggle').getAttribute('aria-expanded')==='false');
   await page.waitForFunction(()=>document.querySelector('.dialog-drawer').getAnimations().every(a=>a.playState==='finished'));
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('.phone-toggle').click();await page.locator('.phone-home-bar').click();
  if(await page.locator('.phone-field').evaluate(el=>getComputedStyle(el).animationName)!=='none')throw Error('Reduced motion wallpaper must stop');
 }else if(scenario==='auto'||scenario==='short'){
  await page.waitForResponse(r=>r.url().includes('/api/phone'));
  if(scenario==='short'){data.lastActivity={eventId:'short-work',runId:'work',source:'qq',peerId:'20001'};await page.evaluate(()=>window.updatePhone({focus:false,activity:null}));}
  else await page.evaluate(()=>window.updatePhone({focus:false,activity:{runId:'work',source:'qq',phase:'thinking'}}));
  await page.waitForFunction(()=>document.querySelector('.phone-toggle')?.getAttribute('aria-expanded')==='true',{},{timeout:5000});
 }else if(scenario==='disabled-live'){
  await toggle.click();await page.getByRole('button',{name:'QQ',exact:true}).click();
  await page.getByRole('button',{name:/20001/}).click();await page.getByText('We can bring tea.',{exact:true}).waitFor();
  data.apps[0].enabled=false;data.pending=0;
  await page.waitForFunction(()=>!document.querySelector('.phone-app-header'),{},{timeout:5000});
  if(await page.getByRole('button',{name:'QQ',exact:true}).count())throw Error('Disabled app must be removed from home');
 }else if(scenario==='disabled'){
  await toggle.click();await page.waitForResponse(r=>r.url().includes('/api/phone'));
  if(await page.getByRole('button',{name:'QQ',exact:true}).count())throw Error('Disabled app must not appear');
 }else{
 await toggle.click();
 const appTile=page.getByRole('button',{name:'QQ',exact:true});await appTile.hover();
 if(await appTile.evaluate(el=>getComputedStyle(el).backgroundColor)!=='rgba(0, 0, 0, 0)')throw Error('App hover must remain transparent');
 await page.screenshot({path:new URL('phone-home-hover.png',out).pathname});
 await appTile.click();
 const back=page.getByRole('button',{name:'返回',exact:true});await back.hover();
 if(!await back.locator('svg').count())throw Error('Back uses the shared light icon treatment');
 await page.screenshot({path:new URL('phone-navigation.png',out).pathname});await page.getByRole('button',{name:/20001/}).click();
 await page.getByText('We can bring tea.',{exact:true}).waitFor();
 const scroller=page.locator('.phone-scroll');await scroller.evaluate(el=>el.scrollTop=el.scrollHeight);
 if(!await scroller.evaluate(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-2))throw Error('Cannot reach scroll bottom');
 if(scenario==='typing'){
  const full='A paced phone reply '.repeat(8);
  data.draft={runId:'typing-run',text:full.slice(0,45)};
  const draft=page.getByRole('textbox',{name:'momo 正在输入'});await draft.waitFor();
  await page.waitForFunction(()=>document.querySelector('.phone-typing textarea')?.value.length>0);
  if((await draft.inputValue()).length>=full.length)throw Error('Draft must be paced');
  data.draft={runId:'typing-run',text:full};
  data.messages.push({id:'out:typing-run',text:full,direction:'out',speaker:'momo',status:'delivered',at:'now'});data.draft=null;
  await page.locator('.phone-message.out p').filter({hasText:full}).waitFor({timeout:10000});
  if(await draft.count())throw Error('Finished reply must leave the draft');
 }
 if(scenario==='scroll'){
  data.messages.push({id:'follow-1',text:'Latest incoming',direction:'in',speaker:'20001',status:'received',at:'now'});
  await page.getByText('Latest incoming',{exact:true}).waitFor();
  if(!await scroller.evaluate(el=>el.scrollTop+el.clientHeight>=el.scrollHeight-2))throw Error('Bottom must follow new messages');
  await scroller.evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'))});
  data.messages.push({id:'follow-2',text:'Do not jump',direction:'in',speaker:'20001',status:'received',at:'now'});
  await page.getByText('Do not jump',{exact:true}).waitFor();
  if(await scroller.evaluate(el=>el.scrollTop)>5)throw Error('Reading history must not jump');
 }
 await page.screenshot({path:new URL('phone-chat.png',out).pathname});
 await page.getByRole('button',{name:'收起手机'}).click();
 await page.evaluate(()=>window.updatePhone({focus:false,activity:{runId:'work',source:'qq',phase:'thinking'}}));
 if(await toggle.getAttribute('aria-expanded')!=='false')throw Error('Explicit close must suppress auto-open');
 await page.getByRole('button',{name:'专注对话',exact:true}).hover();
 await page.getByRole('dialog',{name:'专注对话'}).waitFor();
 if(await page.getByText('暂时不处理手机消息',{exact:true}).count())throw Error('Details must be collapsed');
 await page.getByRole('dialog').getByRole('button').click();await page.getByText('暂时不处理手机消息',{exact:true}).waitFor();
 await page.screenshot({path:new URL('toolbar-help.png',out).pathname});
 await page.setViewportSize({width:960,height:650});await toggle.click();await page.screenshot({path:new URL('phone-narrow.png',out).pathname});
 }
 if(failures.length)throw Error(failures.join('\n'));
 await writeFile(new URL(`smoke-${scenario??'interaction'}.json`,out),JSON.stringify({passed:true,scenario:scenario??'interaction',checks:['manual visibility','plugin QQ view','long content scroll','explicit close suppresses auto','progressive tooltip','narrow viewport'],pageErrors:failures},null,2));console.log('Phone browser smoke passed');
}catch(e){console.log('PAGE ERRORS',failures);console.log((await page.locator('body').innerText()).slice(0,1200));await page.screenshot({path:new URL('failure.png',out).pathname});throw e;}finally{await browser.close()}
