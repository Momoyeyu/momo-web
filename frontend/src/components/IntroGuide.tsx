import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useIntro,refreshIntro,confirmIntroLanguage,finishIntro} from '../services/introClient';
import {navigate,useRoute} from '../router';
import {getChatEngine} from '../chat/engineInstance';
import {leaveMeeting,meetingSnapshot,subscribeMeeting} from '../services/meetingClient';
import {useT} from '../i18n';
import Button from '../ui/Button';
import '../styles/intro.css';

type Box={x:number;y:number;width:number;height:number;stageWidth:number;stageHeight:number};
export default function IntroGuide({ready}:{ready:boolean}){
 const intro=useIntro(),route=useRoute(),t=useT();
 const [guideHeight,setGuideHeight]=useState(140);
 const [box,setBox]=useState<Box|null>(null);
 const [helpOpen,setHelpOpen]=useState(false);
 const [models,setModels]=useState(false);
 const panel=useRef<HTMLDivElement>(null),target=useRef<HTMLElement|null>(null);
 const finishing=useRef(false);
 const phase=intro.data?.phase;
 const restricted=phase!=='completed';
 useEffect(()=>subscribeMeeting(()=>{if(phase==='return_title'&&route==='chat'&&meetingSnapshot().state==='failed')navigate('title');}),[phase,route]);
 useLayoutEffect(()=>{const el=panel.current;if(!el)return;const observer=new ResizeObserver(()=>setGuideHeight(el.offsetHeight));observer.observe(el);return()=>observer.disconnect();},[restricted,ready]);
 const setup=phase==='setup'||(phase==='await_boot'||phase==='naming')&&!intro.data?.configurationValid;
 let anchor='',message='',confirm=false;
 if(setup){
   if(route==='title'){anchor='settings';message='settings';}
   else if(route==='settings'){
     if(!intro.data?.languageConfirmed){anchor='language';message='language';confirm=true;}
     else if(!models){anchor='tab-models';message='models';}
     else{anchor='llm';message='llm';}
   }
 }else if(phase==='await_boot'||phase==='naming'){
   if(route==='settings'){anchor='settings-back';message='back';}
   else if(route==='title'){anchor='boot';message='boot';}
   else if(route==='chat'){anchor='name-input';message='name';}
 }else if(phase==='return_title'){
   if(route==='chat'){anchor='chat-back';message='finish';}
   else message='settling';
 }
 useEffect(()=>{
   if(!restricted)return;
   let stopped=false;
   const poll=async()=>{if(!intro.busy)await refreshIntro();};
   const timer=setInterval(()=>{if(!stopped)void poll();},1000);
   return()=>{stopped=true;clearInterval(timer);};
 },[restricted,intro.busy]);
 useEffect(()=>{
   if(!phase||!restricted)return;
   if(setup && route!=='title'&&route!=='settings')navigate('title');
   if(!setup && phase==='return_title' && (!['title','chat'].includes(route)||route==='chat'&&meetingSnapshot().state!=='active'))navigate('title');
   if(!setup && ['await_boot','naming'].includes(phase) && route==='backlog')navigate('title');
 },[phase,restricted,route,setup]);
 useEffect(()=>{
   if(!ready||!restricted)return;
   let previous:HTMLElement|null=null;
   const fit=()=>{
     setModels(!!document.querySelector('.page-wrap:not([aria-hidden]) [data-intro="tab-models"].active'));
     const stage=document.querySelector('.app-stage')?.getBoundingClientRect();
     const el=document.querySelector<HTMLElement>(`.page-wrap:not([aria-hidden]) [data-intro="${anchor}"]`);
     const sliding=el?.closest('.settings-page')?.querySelector('.settings-track')?.getAnimations().some(a=>a.playState==='running');
     if(!stage||!el||sliding||el.closest('[inert]:not([data-intro-inert])')||anchor==='chat-back'&&getChatEngine().status!=='idle') {target.current=null;setBox(null);return;}
     if(el!==previous){
       const pane=el.closest<HTMLElement>('.settings-pane');
       if(pane){const bounds=pane.getBoundingClientRect(),r=el.getBoundingClientRect();if(r.bottom>bounds.bottom)pane.scrollTop+=r.bottom-bounds.bottom+12;if(r.top<bounds.top)pane.scrollTop+=r.top-bounds.top-12;}
       previous=el;
     }
     target.current=el;
     const raw=el.getBoundingClientRect(),list=el.querySelector('.sel-list')?.getBoundingClientRect();
     const r=list?{x:Math.min(raw.x,list.x),y:Math.min(raw.y,list.y),width:Math.max(raw.right,list.right)-Math.min(raw.x,list.x),height:Math.max(raw.bottom,list.bottom)-Math.min(raw.y,list.y)}:raw;
     const next={x:Math.max(0,r.x-stage.x-7),y:Math.max(0,r.y-stage.y-7),width:Math.min(stage.width,r.width+14),height:Math.min(stage.height,r.height+14),stageWidth:stage.width,stageHeight:stage.height};
     setBox(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
   };
   fit();const timer=setInterval(fit,100);window.addEventListener('resize',fit);document.addEventListener('scroll',fit,true);
   return()=>{clearInterval(timer);window.removeEventListener('resize',fit);document.removeEventListener('scroll',fit,true);target.current=null;};
 },[ready,restricted,anchor,route]);
 useEffect(()=>{
   if(!ready||!restricted)return;
   const activeTarget=target.current;
   const structuralTarget=document.querySelector<HTMLElement>(`.page-wrap:not([aria-hidden]) [data-intro="${anchor}"]`);
   const protectedNodes=[structuralTarget,panel.current].filter((el):el is HTMLElement=>!!el);
   const allowed=[activeTarget,panel.current].filter((el):el is HTMLElement=>!!el);
   const changed=new Map<HTMLElement,boolean>();
   // Inert siblings at every fork, never an ancestor containing the target.
   for(const leaf of protectedNodes){for(let p=leaf.parentElement;p&&p!==document.body;p=p.parentElement){for(const child of p.children){if(child instanceof HTMLElement && !protectedNodes.some(a=>child===a||child.contains(a))&&!child.hasAttribute('inert')){changed.set(child,child.inert);child.dataset.introInert='true';child.inert=true;}}}}
   const permits=(node:EventTarget|null)=>node instanceof Node && allowed.some(el=>el===node||el.contains(node));
   const focusables=()=>allowed.flatMap(el=>Array.from(el.matches('button,input,a,[tabindex]')?[el,...el.querySelectorAll<HTMLElement>('button,input,a,[tabindex]')]:el.querySelectorAll<HTMLElement>('button,input,a,[tabindex]'))).filter(el=>!el.closest('[inert]:not([data-intro-inert])')&&!el.hasAttribute('disabled')&&el.tabIndex>=0&&el.getClientRects().length>0);
   const focus=()=>{if(!permits(document.activeElement))(focusables()[0]??panel.current)?.focus({preventScroll:true});};
   const key=(e:KeyboardEvent)=>{if(e.key==='Tab'){e.preventDefault();const list=focusables();const i=list.indexOf(document.activeElement as HTMLElement);list[(i+(e.shiftKey?-1:1)+list.length)%list.length]?.focus({preventScroll:true});}else if(!permits(e.target)){e.preventDefault();e.stopPropagation();}else if((e.ctrlKey||e.metaKey)&&!['c','v','a','x','z'].includes(e.key.toLowerCase())){e.stopPropagation();}};
   const click=(e:MouseEvent)=>{if(!permits(e.target)){e.preventDefault();e.stopPropagation();}};
   document.addEventListener('focusin',focus,true);document.addEventListener('keydown',key,true);document.addEventListener('click',click,true);focus();
   return()=>{for(const [el,inert]of changed){el.inert=inert;delete el.dataset.introInert;}document.removeEventListener('focusin',focus,true);document.removeEventListener('keydown',key,true);document.removeEventListener('click',click,true);};
 },[ready,restricted,anchor,!!box]);
 useEffect(()=>{
   if(!ready||phase!=='return_title'||route!=='title'||intro.busy||finishing.current)return;
   let cancelled=false;
   const timer=setTimeout(()=>{
     const title=document.querySelector('.page-wrap:not([aria-hidden]) .title-screen');
     if(!title||title.closest('.is-front,.is-leaving'))return;
     finishing.current=true;
     void leaveMeeting(getChatEngine().finishMeeting()).then(()=>cancelled?undefined:finishIntro()).catch(()=>{}).finally(()=>{finishing.current=false;});
   },800);
   return()=>{cancelled=true;clearTimeout(timer);};
 },[ready,phase,route,intro.busy,intro.data]);
 if(!ready||!restricted)return null;
 let style:React.CSSProperties={left:'50%',top:'40%',transform:'translateX(-50%)'};
 if(box){
   const w=Math.min(318,box.stageWidth-32),h=guideHeight;
   let left=box.x,top=box.y+box.height+16;
   if(box.x+box.width+16+w<=box.stageWidth-16){left=box.x+box.width+16;top=box.y;}
   else if(box.x>=w+32){left=box.x-w-16;top=box.y;}
   else if(top+h>box.stageHeight-16)top=box.y-h-16;
   style={left:Math.max(16,Math.min(box.stageWidth-w-16,left)),top:Math.max(16,Math.min(box.stageHeight-h-16,top))};
 }

 return <div className="intro-layer">
   <svg className="intro-shade" width="100%" height="100%" aria-hidden="true"><path fillRule="evenodd" d={box?`M0 0 H${box.stageWidth} V${box.stageHeight} H0 Z M${box.x} ${box.y} h${box.width} v${box.height} h-${box.width} Z`:'M0 0 H10000 V10000 H0 Z'}/></svg>
   {box&&<div className="intro-ring" style={{left:box.x,top:box.y,width:box.width,height:box.height}}/>}
   <div className="intro-guide" data-step={anchor} data-ready={!!box} style={style} ref={panel} tabIndex={-1} role="region" aria-label={t('intro.label')} aria-live="polite">
     <span className="intro-guide-mark" aria-hidden="true">✦</span>
     {anchor==='llm'&&<button className="intro-help hint" aria-label={t('meeting.helpLabel')} aria-expanded={helpOpen} onClick={()=>setHelpOpen(value=>!value)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/></svg></button>}
     {anchor==='llm'&&helpOpen&&<div className="intro-model-help"><p>{t('meeting.connectBody')}</p><a href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">{t('meeting.providerLink')}</a></div>}

     <p>{t(!phase||intro.failed?'intro.loading':!box&&anchor?'intro.preparing':`intro.${message||'loading'}`)}</p>
     {intro.error&&<p role="alert" className="intro-error">{t('intro.error')}</p>}
     {confirm&&box&&<Button size="sm" disabled={intro.busy} onClick={()=>void confirmIntroLanguage().catch(()=>{})}>{t(intro.busy?'intro.checking':'intro.continue')}</Button>}
     {(!phase||intro.failed||intro.error)&&<Button size="sm" variant="ghost" disabled={intro.busy} onClick={()=>void refreshIntro()}>{t('meeting.retry')}</Button>}
   </div>
 </div>;
}
