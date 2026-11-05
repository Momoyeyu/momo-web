import {useState,type ReactNode} from 'react';
import {useT} from '../../i18n';
import {useActivities,setActivityEnabled,type ActivityId} from '../../services/extensionActivities';
import Button from '../../ui/Button';
import Icon from '../../ui/Icon';
import Switch from '../../ui/Switch';
export default function ExtensionCard({id,title,status,onConfigure,children}:{id:ActivityId;title:string;status:string;onConfigure:()=>void;children?:ReactNode}){
 const t=useT(),enabled=useActivities(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 return <article className="plugin-library-card extension-card"><div className="extension-card-heading"><span className="social-app-mark"><Icon name={id==='computer'?'frameFull':id==='browser'?'focus':'play'}/></span><strong>{title}</strong><Switch title={title} on={enabled[id]} disabled={busy} onChange={value=>{setBusy(true);setError(false);void setActivityEnabled(id,value).catch(()=>setError(true)).finally(()=>setBusy(false));}}/></div><div className="extension-card-footer"><span className="muted">{error?t('plugins.error'):status}</span><Button variant="ghost" size="sm" onClick={onConfigure}>{t('browser.configure')}</Button></div>{children}</article>;
}
