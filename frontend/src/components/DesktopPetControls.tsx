import {createPortal} from 'react-dom';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useT} from '../i18n';
import {useDesktopWindow,setDesktopMode,setDesktopClickThrough} from '../services/desktopWindow';
import {useActivities} from '../services/extensionActivities';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import DesktopObservation from './DesktopObservation';

type Props={closeUp:boolean;onFrame:()=>void;collapsed:boolean;onDialog:()=>void;micOn:boolean;micAllowed:boolean;onMic:()=>void};
export default function DesktopPetControls({closeUp,onFrame,collapsed,onDialog,micOn,micAllowed,onMic}:Props){
 const t=useT(),state=useDesktopWindow(),enabled=useActivities();
 const [host,setHost]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>setHost(document.getElementById('desktop-controls-host')),[]);
 const dragging=useRef(false);
 const drag=(phase:'start'|'move'|'end',point?:{x:number;y:number})=>{void window.momoDesktop?.dragPetWindow?.(phase,point).catch(()=>{dragging.current=false;});};
 useEffect(()=>{const stop=()=>{dragging.current=false;drag('end');};window.addEventListener('blur',stop);return()=>{window.removeEventListener('blur',stop);stop();};},[]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(false);
 useEffect(()=>{if(state.mode==='pet'&&!enabled.computer)void setDesktopMode('chat').catch(()=>setError(true));},[state.mode,enabled.computer]);
 useLayoutEffect(()=>{
  if(state.mode!=='pet')return;
  const rail=document.querySelector<HTMLElement>('.desktop-pet-controls'),dialog=document.querySelector<HTMLElement>('.dialog-box');
  if(!rail||!dialog)return;
  const place=()=>{const bottom=Math.min(dialog.offsetHeight+24,Math.max(12,innerHeight-rail.offsetHeight-8));rail.style.bottom=`${bottom}px`;};
  const observer=new ResizeObserver(place);observer.observe(dialog);observer.observe(rail);window.addEventListener('resize',place);place();
  return()=>{observer.disconnect();window.removeEventListener('resize',place);};
 },[state.mode,host]);
 if(state.mode!=='pet')return null;
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(false);try{await action();}catch{setError(true);}finally{setBusy(false);}};
 return <>
  <div className={`desktop-pet-drag${closeUp?' is-close':''}`} aria-hidden="true" style={{pointerEvents:state.clickThrough?'none':undefined}}
   onPointerDown={e=>{if(e.button!==0||!window.momoDesktop?.dragPetWindow)return;e.preventDefault();dragging.current=true;e.currentTarget.setPointerCapture(e.pointerId);drag('start',{x:e.screenX,y:e.screenY});}}
   onPointerMove={()=>{if(dragging.current)drag('move');}}
   onPointerUp={()=>{dragging.current=false;drag('end');}}
   onPointerCancel={()=>{dragging.current=false;drag('end');}}
   onLostPointerCapture={()=>{dragging.current=false;drag('end');}}/>
  {host&&createPortal(<div className="chat-toolbar desktop-pet-controls" role="toolbar" aria-label={t('desktop.controls')} data-pet-interactive>
   <div className="tb-side">
    <Button className="tb tb-framing tip" aria-label={t(closeUp?'performance.fullBody':'desktop.halfBody')} data-tip={t(closeUp?'performance.fullBody':'desktop.halfBody')} data-tip-detail={t('desktop.drag')} onClick={onFrame}><Icon name={closeUp?'frameFull':'frameClose'}/></Button>
    <DesktopObservation/>
    <Button className={`tb tip${micOn?' is-active':''}`} disabled={!micAllowed} aria-pressed={micOn} aria-label={t('chat.mic')} data-tip={t('chat.mic')} onClick={onMic}><Icon name="mic"/></Button>
    <Button className={`tb tip${!collapsed?' is-active':''}`} aria-expanded={!collapsed} aria-label={t(collapsed?'desktop.expandDialog':'desktop.collapseDialog')} data-tip={t(collapsed?'desktop.expandDialog':'desktop.collapseDialog')} onClick={onDialog}><Icon name="message"/></Button>
    <Button className={`tb tip${state.clickThrough?' is-active':''}`} aria-pressed={state.clickThrough} aria-label={t('desktop.clickThrough')} data-tip={t('desktop.clickThrough')} data-tip-detail={t('desktop.clickThroughHint')} disabled={busy} onClick={()=>void run(()=>setDesktopClickThrough(!state.clickThrough))}><Icon name="pointer"/></Button>
    <Button className="tb tip" aria-label={t('desktop.return')} data-tip={t('desktop.return')} disabled={busy} onClick={()=>void run(()=>setDesktopMode('chat'))}><Icon name="home"/></Button>
   </div>
   {error&&<span role="alert">{t('desktop.error')}</span>}
  </div>,host)}
 </>;
}
