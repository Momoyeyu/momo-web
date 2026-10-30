import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
const out=new URL('../../.autodev/runs/v3-011/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:800}});
const failures=[];page.on('pageerror',e=>failures.push(e.message));
const data={apps:[{id:'momo-qq',provider:'qq',name:'QQ',enabled:true,pending:2}],accountKey:'test',pending:2,conversations:[{id:'20001',kind:'private',pending:2,preview:'Garden plans'}],messages:[{id:'a',text:'A long garden message. '.repeat(80),direction:'in',speaker:'20001',status:'held_focus',at:'now'},{id:'b',text:'We can bring tea.',direction:'out',speaker:'momo',status:'delivered',at:'now'}],operations:[],hasMore:false,nextBefore:null,activity:null};
await page.route('**/api/**',route=>route.fulfill({json:data}));
await page.route('**/phone-fixture.html',route=>route.fulfill({contentType:'text/html',body:`<html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div>
<script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script>
<script type="module">
import React from '/node_modules/.vite/deps/react.js';import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';const {createRoot}=ReactDOM;
import Phone from '/src/components/PhoneSurface.tsx';import Tooltips from '/src/ui/TooltipLayer.tsx';import Button from '/src/ui/Button.tsx';import Icon from '/src/ui/Icon.tsx';import '/src/styles/base.css';import '/src/styles/chat.css';
const root=createRoot(document.getElementById('root'));let a={activation:'active',focus:true,phonePaused:false,busy:false,activity:null,presentation:null};
window.updatePhone=s=>{a={...a,...s};render()};
function render(){root.render(React.createElement('div',{className:'app-stage',style:{width:'100vw',height:'100vh',background:'var(--bg)'}},React.createElement('div',{className:'live2d-home'}),React.createElement('div',{className:'chat-page'},React.createElement('div',{className:'chat-toolbar'},React.createElement('div',{className:'tb-side'},React.createElement(Button,{className:'tb', 'data-tip':'专注对话','data-tip-detail':'暂时不处理手机消息','aria-label':'专注对话'},React.createElement(Icon,{name:'focus'})),React.createElement(Phone,{active:true,attention:a})))),React.createElement(Tooltips)))}render();
</script></body></html>`}));
try{
 await page.goto('http://127.0.0.1:5177/phone-fixture.html');
 const toggle=page.getByRole('button',{name:'手机',exact:true});await toggle.waitFor();
 if(await toggle.getAttribute('aria-expanded')!=='false')throw Error('Phone must start closed');
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
 if(failures.length)throw Error(failures.join('\n'));
 await writeFile(new URL('smoke.json',out),JSON.stringify({passed:true,checks:['manual visibility','plugin QQ view','long content scroll','explicit close suppresses auto','progressive tooltip','narrow viewport'],pageErrors:failures},null,2));console.log('Phone browser smoke passed');
}catch(e){console.log('PAGE ERRORS',failures);console.log((await page.locator('body').innerText()).slice(0,1200));await page.screenshot({path:new URL('failure.png',out).pathname});throw e;}finally{await browser.close()}
