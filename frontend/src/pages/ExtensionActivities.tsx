import {useState} from 'react';
import {useT} from '../i18n';
import {useActivities} from '../services/extensionActivities';
import {desktopWindowAvailable,setDesktopMode} from '../services/desktopWindow';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
/** Chat owns only the scene switch; activity controls live in the desktop scene. */
export default function ExtensionActivities(){
 const t=useT(),enabled=useActivities(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const enter=async()=>{if(busy)return;setBusy(true);setError(false);try{await setDesktopMode('pet');}catch{setError(true);}finally{setBusy(false);}};
 if(!enabled.computer||!desktopWindowAvailable())return null;
 return <><Button className="tb tip" data-tip={t('desktop.enter')} data-tip-detail={t('desktop.enterHint')} aria-label={t('desktop.enter')} disabled={busy} onClick={()=>void enter()}><Icon name="desktop"/></Button>{error&&<div role="alert" className="desktop-action-error">{t('desktop.error')}</div>}</>;
}
