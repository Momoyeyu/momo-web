import {configureComputer,computerSnapshot,subscribeComputer,readComputer} from '../../services/computerClient';
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {getSettings,subscribe,updateGeneral} from '../../lib/store';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {useActivities} from '../../services/extensionActivities';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import ExtensionCard from './ExtensionCard';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Icon from '../../ui/Icon';
import FieldRow from '../../ui/FieldRow';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
import NativeWindowNotice, {type NativeWindowDiagnostics} from './NativeWindowNotice';
import AppPermissions from '../../components/AppPermissions';

type Target={windowId:number;ownerPid:number;bundleId:string;path:string;name?:string;title?:string};
type Start={approvalRequired?:boolean;requestId?:string;status?:string;active?:boolean};
export default function NativeCompanion({plugin,mode='settings'}:{plugin:'computer'|'browser';mode?:'settings'|'activity'|'pet'}){
 const computer=useSyncExternalStore(subscribeComputer,computerSnapshot);
 const t=useT(),enabled=useActivities()[plugin],meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const [open,setOpen]=useState(false),[targets,setTargets]=useState<Target[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[active,setActive]=useState(false),[error,setError]=useState(false);
 const preferences=useSyncExternalStore(subscribe,getSettings).general;
 const interact=(plugin==='browser'?preferences.browserInteract:preferences.nativeInteract)===true;
 const setInteract=(value:boolean)=>updateGeneral(plugin==='browser'?{browserInteract:value}:{nativeInteract:value});
 const [activeTarget,setActiveTarget]=useState<Target|null>(null);
 const [diagnostics,setDiagnostics]=useState<NativeWindowDiagnostics|null>(null);
 const [pending,setPending]=useState<string|null>(null);
 const [stopUnconfirmed,setStopUnconfirmed]=useState(false);
 const mounted=useRef(false),operation=useRef(false),request=useRef<AbortController|null>(null);
 const post=<T,>(action:string,body:unknown)=>apiJson<T>('/api/computer/native/'+action,jsonInit('POST',body));
 const read=useCallback(async()=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;
  try{
   const s=await apiJson<{active?:boolean;target?:Target;plugin?:string;stopUnconfirmed?:boolean;stopping?:boolean;pendingRequestId?:string|null}>('/api/computer/native/status',{signal:controller.signal});
   if(controller.signal.aborted||!mounted.current)return;
   setActive(Boolean(s.active&&s.plugin===plugin));
   setActiveTarget(s.active&&s.plugin===plugin?s.target??null:null);
   setPending(s.plugin===plugin?s.pendingRequestId??null:null);
   setStopUnconfirmed(Boolean(s.stopUnconfirmed||s.stopping));

  }catch(e){if(!controller.signal.aborted)throw e;}
  finally{if(request.current===controller)request.current=null;}
 },[plugin]);
 useEffect(()=>{
  mounted.current=true;
  const poll=()=>{if(!request.current&&!operation.current)void read().catch(()=>{if(mounted.current)setError(true);});};
  poll();const timer=setInterval(poll,2500);
  return()=>{mounted.current=false;clearInterval(timer);request.current?.abort();request.current=null;};
 },[read]);
 useEffect(()=>{if(plugin==='computer'&&(open||mode!=='settings'))void readComputer().catch(()=>{});},[plugin,open,mode]);
 const run=async(fn:()=>Promise<void>)=>{
  if(operation.current)return;operation.current=true;setBusy(true);setError(false);request.current?.abort();
  try{await fn();if(mounted.current)await read();}catch{if(mounted.current)setError(true);}
  finally{operation.current=false;if(mounted.current)setBusy(false);}
 };
 const start=async(body:Record<string,unknown>)=>{
  const result=await post<Start>('start',body);if(!mounted.current)return;
  if(result.approvalRequired&&result.status==='pending'&&result.requestId)setPending(result.requestId);
  else{setPending(null);if(result.approvalRequired)setError(true);}
 };
 useEffect(()=>{
  const onDecision=(event:Event)=>{const value=(event as CustomEvent<{id:string}>).detail;if(value.id!==pending)return;setPending(null);void read().catch(()=>setError(true));};
  window.addEventListener('momo:app-permission',onDecision);return()=>window.removeEventListener('momo:app-permission',onDecision);
 },[pending,read]);
 const scanned=useRef(false);
 const findTargets=async()=>{
  const result=await post<{targets:Target[];screenPermission?:boolean;inputPermission?:boolean}>('targets',{...meetingIdentity(),plugin});
  if(!mounted.current)return;setDiagnostics(result);setTargets(result.targets);setSelected(old=>result.targets.some(x=>String(x.windowId)===old)?old:'');
 };
 useEffect(()=>{if(mode==='pet'&&enabled&&meeting.state==='active'&&!scanned.current){scanned.current=true;void run(findTargets);}},[mode,enabled,meeting.state]);
 const target=targets.find(x=>String(x.windowId)===selected);
 const status=t(stopUnconfirmed?'plugins.stopUnknown':pending?'permissions.waiting':active?'browser.active':'browser.inactive');
 if(mode==='pet')return <div className="pet-control">
  {active&&activeTarget?<div className="pet-current-target"><Icon name="desktop"/><div><strong>{activeTarget.name||activeTarget.bundleId}</strong><small>{activeTarget.title}</small></div><span className="pet-live-dot" aria-label={status}/></div>:<div className="pet-target-list" role="list" aria-label={t('permissions.window')}>
   {targets.map(x=><button type="button" role="listitem" className="pet-target" key={x.windowId} aria-pressed={selected===String(x.windowId)} disabled={busy||!!pending} onClick={()=>setSelected(String(x.windowId))}><Icon name="desktop"/><span><strong>{x.name||x.bundleId}</strong><small>{x.title||String(x.windowId)}</small></span>{selected===String(x.windowId)&&<Icon name="check"/>}</button>)}
   {!targets.length&&!busy&&<p className="pet-empty">{t(diagnostics?.screenPermission===false?'permissions.screenPermission':'permissions.noWindows')}</p>}
  </div>}
  {pending&&<p className="pet-control-status" role="status">{t('permissions.waiting')}</p>}
  {error&&<p role="alert" className="pet-control-status">{t('permissions.error')}</p>}
  <footer className="pet-control-footer">
   {!active&&!pending&&<button type="button" className="pet-icon tip" aria-label={t('permissions.findWindows')} data-tip={t('permissions.findWindows')} disabled={busy} onClick={()=>void run(findTargets)}><Icon name="load"/></button>}
   <Hint text={t('desktop.operateHint')}/>
   {active||pending||stopUnconfirmed?<button type="button" className="pet-icon is-primary tip" aria-label={t('browser.stop')} data-tip={t('browser.stop')} disabled={busy} onClick={()=>void run(async()=>{await post('stop',{...meetingIdentity(),plugin});setPending(null);})}><Icon name="stop"/></button>:<button type="button" className="pet-icon is-primary tip" aria-label={t('desktop.operate')} data-tip={t('desktop.operate')} disabled={!target||busy||!enabled||meeting.state!=='active'} onClick={()=>void run(()=>start({...meetingIdentity(),plugin,windowId:target!.windowId,ownerPid:target!.ownerPid,permissions:['observe','interact']}))}><Icon name="play"/></button>}
  </footer>
 </div>;
 const body=<div className="extension-detail">
  <header className="extension-detail-header"><div><h3>{t(plugin+'.title')}</h3><span className={`extension-detail-status${active?' is-active':''}`}>{status}</span></div>{mode==='settings'&&<button type="button" className="icon-btn" aria-label={t('browser.dismiss')} onClick={()=>setOpen(false)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>}</header>
  <section className="extension-detail-section">
   <FieldRow label={t('permissions.window')} hint={t('permissions.existingHint')}>
    {active&&activeTarget?<span className="desktop-observed-target">{activeTarget.name||activeTarget.bundleId} · {activeTarget.title||activeTarget.windowId}</span>:<select className="extension-window-select" aria-label={t('permissions.window')} value={selected} disabled={busy||active||Boolean(pending)} onChange={e=>setSelected(e.target.value)}>
     <option value="">{t('permissions.selectWindow')}</option>{targets.map(x=><option key={x.windowId} value={String(x.windowId)}>{x.name||x.bundleId} · {x.title||x.windowId}</option>)}
    </select>}
   </FieldRow>
   {!active&&<div className="extension-detail-actions"><Button variant="ghost" disabled={busy||active||Boolean(pending)||meeting.state!=='active'} onClick={()=>void run(findTargets)}>{t('permissions.findWindows')}</Button></div>}
   <NativeWindowNotice result={diagnostics} interact={interact}/>
   {<FieldRow label={t('permissions.interact')} hint={t('permissions.interactHint')}><Switch title={t('permissions.interact')} on={interact} onChange={setInteract} disabled={busy||active||Boolean(pending)}/></FieldRow>}
   <div className="extension-detail-actions">
    {(!active&&!pending&&!stopUnconfirmed)&&<Button disabled={!enabled||busy||active||stopUnconfirmed||!target||meeting.state!=='active'||Boolean(pending)} onClick={()=>void run(()=>start({...meetingIdentity(),plugin,windowId:target!.windowId,ownerPid:target!.ownerPid,permissions:interact?['observe','interact']:['observe']}))}>{t('browser.start')}</Button>}
    {(active||pending||stopUnconfirmed)&&<Button variant="ghost" disabled={busy||(!active&&!pending&&!stopUnconfirmed)} onClick={()=>void run(async()=>{await post('stop',{...meetingIdentity(),plugin});setPending(null);})}>{t('browser.stop')}</Button>}
   </div>
  </section>
  {plugin==='computer'&&<details className="extension-detail-section extension-detail-advanced" open><summary>{t('computer.companionship')} <Hint text={t('computer.behaviorHint')}/></summary>
   <FieldRow label={t('computer.proactive')}><Switch title={t('computer.proactive')} disabled={busy} on={computer.status?.proactive??false} onChange={v=>void run(async()=>{await configureComputer(v,computer.status?.reactions??false);})}/></FieldRow>
   <FieldRow label={t('computer.reactions')}><Switch title={t('computer.reactions')} disabled={busy} on={computer.status?.reactions??false} onChange={v=>void run(async()=>{await configureComputer(computer.status?.proactive??false,v);})}/></FieldRow>
  </details>}
  {mode==='settings'&&<details className="extension-detail-section extension-detail-advanced"><summary>{t('permissions.allowed')}</summary><AppPermissions manage/></details>}
  {meeting.state!=='active'&&<p className="extension-detail-notice">{t('computer.requiresBoot')}</p>}{error&&<p role="alert" className="extension-detail-notice">{t('permissions.error')}</p>}
 </div>;
 if(mode!=='settings')return body;
 return <ExtensionCard id={plugin} title={t(plugin+'.title')} status={status} running={active} onConfigure={()=>setOpen(true)}>{open&&<Modal className="extension-modal" label={t(plugin+'.title')} onClose={()=>setOpen(false)}>{body}</Modal>}</ExtensionCard>;
}
