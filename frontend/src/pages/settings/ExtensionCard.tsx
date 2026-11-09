import {useRef,useState,type ReactNode} from 'react';
import {useT} from '../../i18n';
import {useActivities,activitySupported,setActivityEnabled,type ActivityId} from '../../services/extensionActivities';
import Button from '../../ui/Button';
import Icon from '../../ui/Icon';
import Switch from '../../ui/Switch';
export default function ExtensionCard({id,title,status,running=false,onConfigure,children}:{id:ActivityId;title:string;status:string;running?:boolean;onConfigure:()=>void;children?:ReactNode}){
 const t=useT(),enabled=useActivities(),[busy,setBusy]=useState(false),[error,setError]=useState(false),lock=useRef(false);
 return <article className="plugin-library-card extension-card">
  <div className="extension-card-heading"><span className="social-app-mark" aria-hidden="true"><Icon name={id==='computer'?'desktop':id==='browser'?'browser':'gamepad'} size={24}/></span><h4>{title}</h4><Switch title={title} on={enabled[id]} disabled={busy||!activitySupported(id)} onChange={value=>{if(lock.current)return;lock.current=true;setBusy(true);setError(false);void setActivityEnabled(id,value).catch(()=>setError(true)).finally(()=>{lock.current=false;setBusy(false);});}}/></div>
  <p className="extension-card-summary">{t(`activities.${id}Summary`)}</p>
  <div className="extension-card-footer"><span className={`social-state${running?' is-connected':''}`} role={error?'alert':undefined}><i/>{!activitySupported(id)?t('activities.platformUnsupported'):error?t('plugins.error'):enabled[id]?status:t('activities.disabled')}</span><Button variant="ghost" size="sm" disabled={!activitySupported(id)} onClick={onConfigure}>{t('browser.configure')}</Button></div>{children}
 </article>;
}
