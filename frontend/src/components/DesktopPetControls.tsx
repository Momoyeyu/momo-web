import {useEffect,useState} from 'react';
import {useT} from '../i18n';
import {useDesktopWindow,setDesktopMode,setDesktopClickThrough} from '../services/desktopWindow';
import {useActivities} from '../services/extensionActivities';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
export default function DesktopPetControls(){
 const t=useT(),state=useDesktopWindow(),enabled=useActivities();
 const [busy,setBusy]=useState(false),[error,setError]=useState(false);
 useEffect(()=>{if(state.mode==='pet'&&!enabled.computer)void setDesktopMode('chat').catch(()=>setError(true));},[state.mode,enabled.computer]);
 if(state.mode!=='pet')return null;
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(false);try{await action();}catch{setError(true);}finally{setBusy(false);}};
 return <div className="desktop-pet-controls"><div className="desktop-pet-grip" title={t('desktop.drag')} aria-label={t('desktop.drag')}><i/><i/></div>
  <Button className="tb tip" aria-label={t('desktop.clickThrough')} data-tip={t('desktop.clickThrough')} data-tip-detail={t('desktop.clickThroughHint')} disabled={busy} onClick={()=>void run(()=>setDesktopClickThrough(!state.clickThrough))}><Icon name="pointer"/></Button>
  <Button className="tb" aria-label={t('desktop.return')} title={t('desktop.return')} disabled={busy} onClick={()=>void run(()=>setDesktopMode('chat'))}><Icon name="message"/></Button>
  {error&&<span role="alert">{t('desktop.error')}</span>}
 </div>;
}
