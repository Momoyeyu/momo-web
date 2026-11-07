import {useEffect,useState} from 'react';
import {useT} from '../i18n';
import {useActivities,type ActivityId} from '../services/extensionActivities';
import {apiJson} from '../services/http';
import {startNativeObservation,stopNativeObservation} from '../services/computerClient';
import NativeCompanion from '../pages/settings/NativeCompanion';
import MinecraftCompanion from '../pages/settings/MinecraftCompanion';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import Modal from '../ui/Modal';
import '../styles/plugin-library.css';

/** A scene action, not a second plugin/configuration directory. */
export default function DesktopObservation(){
 const t=useT(),enabled=useActivities();
 const [open,setOpen]=useState(false),[selected,setSelected]=useState<ActivityId>('computer');
 const [active,setActive]=useState(false),[activePlugin,setActivePlugin]=useState<'computer'|'browser'>('computer');
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{
   try{const state=await apiJson<{active:boolean;plugin?:string}>('/api/computer/native/status',{signal:controller.signal});
    if(!controller.signal.aborted){setActive(state.active);setActivePlugin(state.plugin==='browser'?'browser':'computer');if(state.active&&state.plugin==='computer')startNativeObservation();else stopNativeObservation();}
   }catch{if(!controller.signal.aborted)setActive(false);}
   if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),2500);
  };
  void poll();return()=>{controller.abort();clearTimeout(timer);};
 },[]);
 const current=enabled[selected]?selected:'computer';
 return <>
  <Button className={`tb tip${active?' is-active':''}`} aria-label={t('desktop.observe')} aria-pressed={active} data-tip={t(active?'desktop.observing':'desktop.observe')} onClick={()=>{setSelected(active?activePlugin:'computer');setOpen(true);}}><Icon name="desktop"/></Button>
  {open&&<Modal className="extension-modal desktop-observation" label={t('desktop.observe')} onClose={()=>setOpen(false)}>
   <header className="desktop-observation-heading">
    {current!=='computer'&&<Button variant="ghost" onClick={()=>setSelected('computer')} aria-label={t('desktop.observe')}><Icon name="back"/></Button>}
    <span>{t('desktop.observe')}</span>
    <Button variant="ghost" onClick={()=>setOpen(false)} aria-label={t('browser.dismiss')}><Icon name="close"/></Button>
   </header>
   <div className="desktop-observation-body">
    {current==='minecraft'?<MinecraftCompanion mode="activity"/>:<NativeCompanion key={current} plugin={current} mode="pet"/>}
    {current==='computer'&&(enabled.browser||enabled.minecraft)&&<details className="desktop-other-activities">
     <summary>{t('desktop.otherActivities')}</summary>
     <div>{(['browser','minecraft'] as const).filter(id=>enabled[id]).map(id=><Button key={id} variant="ghost" onClick={()=>setSelected(id)}><Icon name={id==='browser'?'browser':'gamepad'}/>{t(id+'.title')}</Button>)}</div>
    </details>}
   </div>
  </Modal>}
 </>;
}
