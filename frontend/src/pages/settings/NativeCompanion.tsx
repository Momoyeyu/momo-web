import {startNativeObservation,stopNativeObservation,configureComputer,computerSnapshot,subscribeComputer,readComputer} from '../../services/computerClient';
import {useEffect,useState,useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {useActivities} from '../../services/extensionActivities';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import ExtensionCard from './ExtensionCard';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Switch from '../../ui/Switch';
import AppPermissions from '../../components/AppPermissions';
type Target={windowId:number;ownerPid:number;bundleId:string;path:string;name?:string;title?:string};
type Start={approvalRequired?:boolean;requestId?:string;status?:string;active?:boolean};
export default function NativeCompanion({plugin}:{plugin:'computer'|'browser'}){
 const computer=useSyncExternalStore(subscribeComputer,computerSnapshot);
 const t=useT(),enabled=useActivities()[plugin],meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const [open,setOpen]=useState(false),[targets,setTargets]=useState<Target[]>([]),[selected,setSelected]=useState(''),[interact,setInteract]=useState(false),[busy,setBusy]=useState(false),[active,setActive]=useState(false),[error,setError]=useState(false);
 const [pending,setPending]=useState<{id:string;body:Record<string,unknown>}|null>(null);
 const post=<T,>(action:string,body:unknown)=>apiJson<T>('/api/computer/native/'+action,jsonInit('POST',body));
 const read=async()=>{const s=await apiJson<{active?:boolean;plugin?:string}>('/api/computer/native/status');setActive(Boolean(s.active&&s.plugin===plugin));if(s.active&&s.plugin==='computer')startNativeObservation();};
 useEffect(()=>{if(!open)return;let alive=true;void read().catch(()=>{});if(plugin==='computer')void readComputer().catch(()=>{});const timer=setInterval(()=>{if(alive)void read().catch(()=>{});},2000);return()=>{alive=false;clearInterval(timer);};},[open,plugin,meeting.state]);
 const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError(false);try{await fn();}catch{setError(true);}finally{setBusy(false);}};
 const start=async(body:Record<string,unknown>)=>{const result=await post<Start>('start',body);if(result.approvalRequired&&result.status==='pending'&&result.requestId)setPending({id:result.requestId,body});else{setPending(null);if(result.approvalRequired)setError(true);await read();}};
 useEffect(()=>{const onDecision=(event:Event)=>{const value=(event as CustomEvent<{id:string;decision:string}>).detail;if(!pending||value.id!==pending.id)return;setPending(null);void read().catch(()=>setError(true));};window.addEventListener('momo:app-permission',onDecision);return()=>window.removeEventListener('momo:app-permission',onDecision);},[pending,busy]);
 const target=targets.find(x=>String(x.windowId)===selected);
 return <ExtensionCard id={plugin} title={t(plugin+'.title')} status={t(active?'browser.active':'browser.inactive')} onConfigure={()=>setOpen(true)}>{open&&<Modal className="extension-modal" label={t(plugin+'.title')} onClose={()=>setOpen(false)}><div className="extension-modal-heading"><h3>{t(plugin+'.title')}</h3><Button variant="ghost" aria-label={t('browser.dismiss')} onClick={()=>setOpen(false)}>×</Button></div><p>{t('permissions.existingHint')}</p>
 <Button disabled={busy||meeting.state!=='active'} onClick={()=>void run(async()=>{const result=await post<{targets:Target[]}>('targets',{...meetingIdentity(),plugin});setTargets(result.targets);})}>{t('permissions.findWindows')}</Button>
 <label>{t('permissions.window')}<select className="list-search" value={selected} disabled={busy||active} onChange={e=>setSelected(e.target.value)}><option value="">{t('permissions.selectWindow')}</option>{targets.map(x=><option key={x.windowId} value={String(x.windowId)}>{x.name||x.bundleId} · {x.title||x.windowId}</option>)}</select></label>
 <div className="plugin-library-actions"><span>{t('permissions.interact')}</span><Switch title={t('permissions.interact')} on={interact} onChange={setInteract} disabled={busy||active}/></div>
 <div className="plugin-library-actions"><Button disabled={!enabled||busy||active||!target||meeting.state!=='active'||Boolean(pending)} onClick={()=>void run(()=>start({...meetingIdentity(),plugin,windowId:target!.windowId,ownerPid:target!.ownerPid,permissions:interact?['observe','interact']:['observe']}))}>{t('browser.start')}</Button><Button variant="ghost" disabled={busy||!active} onClick={()=>void run(async()=>{setPending(null);await post('stop',{...meetingIdentity(),plugin});if(plugin==='computer')stopNativeObservation();await read();})}>{t('browser.stop')}</Button></div>
 {plugin==='computer'&&<div className="plugin-library-actions"><span>{t('computer.proactive')}</span><Switch title={t('computer.proactive')} on={computer.status?.proactive??false} onChange={v=>void run(async()=>{await configureComputer(v,computer.status?.reactions??false);})}/><span>{t('computer.reactions')}</span><Switch title={t('computer.reactions')} on={computer.status?.reactions??false} onChange={v=>void run(async()=>{await configureComputer(computer.status?.proactive??false,v);})}/></div>}
 {pending&&<p role="status">{t('permissions.waiting')}</p>}{meeting.state!=='active'&&<p>{t('computer.requiresBoot')}</p>}{error&&<p role="alert">{t('permissions.error')}</p>}{plugin==='computer'&&<AppPermissions manage/>}</Modal>}</ExtensionCard>;
}
