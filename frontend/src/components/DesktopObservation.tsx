import {createPortal} from 'react-dom';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useT} from '../i18n';
import {useActivities,type ActivityId} from '../services/extensionActivities';
import {captureDesktop,computerSnapshot,setDesktopObservation,subscribeComputer} from '../services/computerClient';
import {setDesktopPanel,useDesktopWindow} from '../services/desktopWindow';
import ProactiveResponseToggle from './ProactiveResponseToggle';
import NativeCompanion from '../pages/settings/NativeCompanion';
import MinecraftCompanion from '../pages/settings/MinecraftCompanion';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import '../styles/plugin-library.css';

/** Looking is a sense; application input is a separately authorized activity. */
export default function DesktopObservation(){
 const t=useT(),enabled=useActivities(),windowState=useDesktopWindow();
 const view=useSyncExternalStore(subscribeComputer,computerSnapshot);
 const [open,setOpen]=useState(false),[selected,setSelected]=useState<ActivityId>('computer'),[working,setWorking]=useState(false);
 const panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const allowed=view.status?.desktopAllowed!==false;
 const problem=view.status?.desktopError;
 const observationState=!view.status?'loading':!allowed?'off':problem?'error':'on';
 const observationTip=t(observationState==='on'?'desktop.observing':observationState==='off'?'desktop.observationPaused':observationState==='error'?'desktop.observationUnavailable':'desktop.observationLoading');
 useEffect(()=>()=>{void setDesktopPanel(false).catch(()=>{});},[]);
 const close=()=>{setOpen(false);void setDesktopPanel(false).catch(()=>{});trigger.current?.focus();};
 useEffect(()=>{if(open)panel.current?.focus();},[open,windowState.panel]);
 const show=async()=>{if(open){close();return;}try{await setDesktopPanel(true);setOpen(true);}catch{/* Keep the trigger available for retry. */}};
 const toggle=async()=>{if(working)return;setWorking(true);try{await setDesktopObservation(problem?true:!allowed);if(problem)await captureDesktop();}catch{/* The status store exposes capture/permission failure. */}finally{setWorking(false);}};
 const title=selected==='computer'?t('desktop.operate'):t(selected+'.title');
 return <>
  <Button className="tb tip tb-observation" data-observation-state={observationState} aria-label={t('desktop.observe')} aria-pressed={allowed} aria-description={observationTip} data-tip={observationTip} data-tip-detail={t(problem==='screen-permission'?'desktop.screenPermissionHint':observationState==='off'?'desktop.resumeObservationHint':observationState==='error'?'desktop.retryObservationHint':'desktop.pauseObservationHint')} disabled={working||view.busy||!view.status} onClick={()=>void toggle()}><Icon name={observationState==='off'?'desktop-off':observationState==='error'?'desktop-alert':'desktop'}/></Button>
  <ProactiveResponseToggle/>
  <button ref={trigger} type="button" className={`tb tip${open?' is-active':''}`} aria-label={t('desktop.operate')} aria-expanded={open} data-tip={t('desktop.operate')} onClick={()=>void show()}><Icon name="browser"/></button>
  {open&&createPortal(<div ref={panel} tabIndex={-1} role="dialog" aria-label={t('desktop.operate')} className={`pet-utility${windowState.panel?.width&&windowState.panel.width>=220?' is-beside':''}`} data-pet-interactive onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}}>
   <header className="pet-utility-header"><span>{title}</span><button type="button" className="pet-icon" aria-label={t('browser.dismiss')} onClick={close}><Icon name="close"/></button></header>
   <nav className="pet-utility-tabs" aria-label={t('desktop.otherActivities')}>
    {(['computer','browser','minecraft'] as const).filter(id=>enabled[id]).map(id=><button key={id} type="button" className="pet-icon tip" aria-label={id==='computer'?t('desktop.operate'):t(id+'.title')} data-tip={id==='computer'?t('desktop.operate'):t(id+'.title')} aria-pressed={selected===id} onClick={()=>setSelected(id)}><Icon name={id==='computer'?'pointer':id==='browser'?'browser':'gamepad'}/></button>)}
   </nav>
   <div className="pet-utility-body">
    {selected==='minecraft'?<MinecraftCompanion mode="activity"/>:<NativeCompanion key={selected} plugin={selected} mode="pet"/>}
   </div>
  </div>,document.body)}
 </>;
}
