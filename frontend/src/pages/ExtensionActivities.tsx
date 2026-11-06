import {useState} from 'react';
import {useT} from '../i18n';
import {useActivities,type ActivityId} from '../services/extensionActivities';
import {desktopWindowAvailable,setDesktopMode} from '../services/desktopWindow';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import Modal from '../ui/Modal';
import NativeCompanion from './settings/NativeCompanion';
import MinecraftCompanion from './settings/MinecraftCompanion';
import '../styles/plugin-library.css';
const ids:ActivityId[]=['computer','browser','minecraft'];
export default function ExtensionActivities(){
 const t=useT(),enabled=useActivities(),[open,setOpen]=useState(false),[tab,setTab]=useState<ActivityId>('computer');
 const [busy,setBusy]=useState(false),[error,setError]=useState(false);
 const available=ids.filter(id=>enabled[id]),selected=available.includes(tab)?tab:available[0];
 const enterDesktop=async()=>{if(busy)return;setBusy(true);setError(false);try{await setDesktopMode('pet');setOpen(false);}catch{setError(true);}finally{setBusy(false);}};
 return <>
  {enabled.computer&&desktopWindowAvailable()&&<Button className="tb tip" data-tip={t('desktop.enter')} data-tip-detail={t('desktop.enterHint')} aria-label={t('desktop.enter')} disabled={busy} onClick={()=>void enterDesktop()}><Icon name="desktop"/></Button>}
  <Button className="tb" title={t('settings.tabs.extend')} aria-label={t('settings.tabs.extend')} onClick={()=>{setOpen(true);setError(false);}}><Icon name="extensions"/></Button>
  {error&&!open&&<div role="alert" className="desktop-action-error">{t('desktop.error')}</div>}
  {open&&<Modal className="extension-modal extension-activities" label={t('activities.title')} onClose={()=>setOpen(false)}>
   <header className="extension-modal-heading"><h3>{t('activities.title')}</h3><button className="icon-btn" type="button" aria-label={t('browser.dismiss')} onClick={()=>setOpen(false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
   <div className="activity-tabs" role="tablist" aria-label={t('activities.title')}>{available.map((id,index)=><button type="button" key={id} id={`activity-tab-${id}`} role="tab" aria-selected={id===selected} tabIndex={id===selected?0:-1} aria-controls="activity-content" onClick={()=>setTab(id)} onKeyDown={event=>{
    const next=event.key==='ArrowRight'?available[(index+1)%available.length]:event.key==='ArrowLeft'?available[(index+available.length-1)%available.length]:event.key==='Home'?available[0]:event.key==='End'?available.at(-1):null;
    if(next){event.preventDefault();setTab(next);document.getElementById(`activity-tab-${next}`)?.focus();}
   }}><Icon name={id==='computer'?'desktop':id==='browser'?'browser':'gamepad'}/><span>{t(`${id}.title`)}</span></button>)}</div>
   {selected?<div id="activity-content" role="tabpanel" aria-labelledby={`activity-tab-${selected}`}>
    {selected==='computer'&&desktopWindowAvailable()&&<div className="activity-desktop-action"><Button disabled={busy} onClick={()=>void enterDesktop()}><Icon name="desktop"/>{t('desktop.enter')}</Button></div>}
    {selected==='minecraft'?<MinecraftCompanion mode="activity"/>:<NativeCompanion key={selected} plugin={selected} mode="activity"/>}
   </div>:<p className="muted">{t('activities.empty')}</p>}
   {error&&<p role="alert">{t('desktop.error')}</p>}
  </Modal>}
 </>;
}
