import {configureComputer,computerSnapshot,subscribeComputer,readComputer} from '../../services/computerClient';
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {useActivities} from '../../services/extensionActivities';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import {withDesktopPermissions,type DesktopOperation} from '../../services/desktopPermissionGate';
import ExtensionCard from './ExtensionCard';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import DialogBackButton from '../../ui/DialogBackButton';
import Select from '../../ui/Select';
import Icon from '../../ui/Icon';
import FieldRow from '../../ui/FieldRow';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
import NativeWindowNotice, {type NativeWindowDiagnostics} from './NativeWindowNotice';
import AppPermissions from '../../components/AppPermissions';

type Target={windowId:number;ownerPid:number;bundleId:string;path:string;name?:string;title?:string};
// A selection is a suggestion for this app window, never an activity grant.
const selectedWindows: Partial<Record<'computer'|'browser',Target>> = {};
const targetKey = (target: Target) => `${target.ownerPid}:${target.windowId}`;
const targetLabel = (target: Target) => `${target.name || target.bundleId} · ${target.title || target.windowId}`;

export default function NativeCompanion({plugin,mode='settings'}:{plugin:'computer'|'browser';mode?:'settings'|'activity'|'pet'|'inline'}){
 const computer=useSyncExternalStore(subscribeComputer,computerSnapshot);
 const t=useT(),enabled=useActivities()[plugin],meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const rememberSelection=mode==='inline'||mode==='activity';
 const saved=rememberSelection?selectedWindows[plugin]:undefined;
 const [open,setOpen]=useState(false),[targets,setTargets]=useState<Target[]>(()=>saved?[saved]:[]),[selected,setSelected]=useState(()=>saved?targetKey(saved):''),[busy,setBusy]=useState(false),[active,setActive]=useState(false);
 const [actionFailed,setActionFailed]=useState(false);
 const [scanState,setScanState]=useState<'idle'|'loading'|'failed'>('idle');
 const [reopenKey,setReopenKey]=useState(0);
 const scanRequest=useRef<AbortController|null>(null);
 const [statusState,setStatusState]=useState<'loading'|'ready'|'failed'>('loading');
 const [activeTarget,setActiveTarget]=useState<Target|null>(null);
 const [diagnostics,setDiagnostics]=useState<NativeWindowDiagnostics|null>(null);
 const [stopUnconfirmed,setStopUnconfirmed]=useState(false);
 const mounted=useRef(false),operation=useRef(false),request=useRef<AbortController|null>(null);
 const post=<T,>(action:string,body:unknown)=>apiJson<T>('/api/computer/native/'+action,jsonInit('POST',body));
 const read=useCallback(async()=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;
  try{
   const s=await apiJson<{active?:boolean;target?:Target;plugin?:string;stopUnconfirmed?:boolean;stopping?:boolean}>('/api/computer/native/status',{signal:controller.signal});
   if(controller.signal.aborted||!mounted.current)return;
   setStatusState('ready');
   setActive(Boolean(s.active&&s.plugin===plugin));
   setActiveTarget(s.active&&s.plugin===plugin?s.target??null:null);
   setStopUnconfirmed(Boolean(s.stopUnconfirmed||s.stopping));

  }catch{if(!controller.signal.aborted&&mounted.current)setStatusState('failed');}
  finally{if(request.current===controller)request.current=null;}
 },[plugin]);
 useEffect(()=>{
  mounted.current=true;
  const poll=()=>{if(!request.current&&!operation.current)void read();};
  poll();const timer=setInterval(poll,2500);
  return()=>{mounted.current=false;clearInterval(timer);request.current?.abort();request.current=null;scanRequest.current?.abort();};
 },[read]);
 useEffect(()=>{if(plugin==='computer'&&(open||mode!=='settings'))void readComputer().catch(()=>{});},[plugin,open,mode]);
 const run=async(fn:()=>Promise<void>, check?:DesktopOperation)=>{
  if(!mounted.current||operation.current)return;
  operation.current=true;setBusy(true);setActionFailed(false);request.current?.abort();
  try{
   const performed=check
    ? await withDesktopPermissions(check,fn,()=>run(fn,check))
    : (await fn(),true);
   if(performed&&mounted.current)await read();
  }catch{if(mounted.current)setActionFailed(true);}
  finally{operation.current=false;if(mounted.current)setBusy(false);}
 };
 const start=async(body:Record<string,unknown>)=>{await post('start',body);};
 const scanned=useRef(false);
 const findTargets=async(signal?:AbortSignal)=>{
  const result=await apiJson<Omit<NativeWindowDiagnostics,'targets'> & {targets:Target[]}>('/api/computer/native/targets',{
   ...jsonInit('POST',{plugin}),signal,
  });
  if(!mounted.current||signal?.aborted)return;
  setDiagnostics(result);setTargets(result.targets);
  const refreshed=result.targets.find(x=>targetKey(x)===selected);
  if(rememberSelection)selectedWindows[plugin]=refreshed;
  setSelected(refreshed?targetKey(refreshed):'');
 };
 const refreshPicker=async(reopen=false)=>{
  if(!mounted.current)return;
  scanRequest.current?.abort();
  const controller=new AbortController();
  scanRequest.current=controller;
  setScanState('loading');
  try{
   const performed=await withDesktopPermissions('targets',()=>findTargets(controller.signal),()=>refreshPicker(true),controller.signal);
   if(controller.signal.aborted)return;
   setScanState('idle');
   if(performed&&reopen)setReopenKey(key=>key+1);
  }catch{
   if(!controller.signal.aborted)setScanState('failed');
  }
 };
 useEffect(()=>{
  if(mode==='pet'&&enabled&&meeting.state==='active'&&!scanned.current){scanned.current=true;void run(findTargets,'targets');}
 },[mode,enabled,meeting.state]);
 const target=targets.find(x=>targetKey(x)===selected);
 const live=meeting.state==='active';
 const startSelected=()=>{
  const identity=meetingIdentity();
  if(!identity||!target)return;
  void run(async()=>{
   if(meetingIdentity()?.leaseId!==identity.leaseId)return;
   await start({...identity,plugin,windowId:target.windowId,ownerPid:target.ownerPid,permissions:['observe','interact']});
  },'control');
 };
 const selectWindow=(value:string)=>{
  setSelected(value);
  if(rememberSelection)selectedWindows[plugin]=targets.find(x=>targetKey(x)===value);
 };
 const status=t(stopUnconfirmed?'plugins.stopUnknown':active?'browser.active':'browser.inactive');
 if(mode==='pet')return <div className="pet-control">
  {active&&activeTarget?<div className="pet-current-target"><Icon name="desktop"/><div><strong>{activeTarget.name||activeTarget.bundleId}</strong><small>{activeTarget.title}</small></div><span className="pet-live-dot" aria-label={status}/></div>:<div className="pet-target-list" role="list" aria-label={t('permissions.window')}>
   {targets.map(x=><button type="button" role="listitem" className="pet-target" key={targetKey(x)} aria-pressed={selected===targetKey(x)} disabled={busy} onClick={()=>setSelected(targetKey(x))}><Icon name="desktop"/><span><strong>{x.name||x.bundleId}</strong><small>{x.title||String(x.windowId)}</small></span>{selected===targetKey(x)&&<Icon name="check"/>}</button>)}
   {!targets.length&&!busy&&<p className="pet-empty">{t(diagnostics?.screenPermission===false?'permissions.screenPermission':'permissions.noWindows')}</p>}
  </div>}
  {(actionFailed||statusState==='failed')&&<p role="alert" className="pet-control-status">{t(actionFailed?'permissions.error':'config.unavailable')}</p>}
  <footer className="pet-control-footer">
   {!active&&<button type="button" className="pet-icon tip" aria-label={t('permissions.findWindows')} data-tip={t('permissions.findWindows')} disabled={busy} onClick={()=>void run(findTargets,'targets')}><Icon name="load"/></button>}
   <Hint text={t('desktop.operateHint')}/>
   {active||stopUnconfirmed?<button type="button" className="pet-icon is-primary tip" aria-label={t('browser.stop')} data-tip={t('browser.stop')} disabled={busy} onClick={()=>void run(async()=>{await post('stop',{...meetingIdentity(),plugin});})}><Icon name="stop"/></button>:<button type="button" className="pet-icon is-primary tip" aria-label={t('desktop.operate')} data-tip={t('desktop.operate')} disabled={!target||busy||!enabled||meeting.state!=='active'} onClick={startSelected}><Icon name="play"/></button>}
  </footer>
 </div>;
 const findButton = mode!=='inline' && !active && <Button variant="ghost" disabled={busy} onClick={()=>void run(findTargets,'targets')}>{t('permissions.findWindows')}</Button>;
 const runButton = active||stopUnconfirmed
  ? <Button variant="ghost" className={mode==='inline'?'config-action':undefined} disabled={busy} onClick={()=>void run(async()=>{await post('stop',{...meetingIdentity(),plugin});})}>{t('browser.stop')}</Button>
  : live && <Button className={mode==='inline'?'config-action':undefined} disabled={!enabled||busy||!target||scanState==='loading'} onClick={startSelected}>{t('browser.start')}</Button>;
 const pickerNotice = mode==='inline' && <div className="window-scan-feedback">
  {scanState==='loading' ? <span role="status">{t('config.loading')}</span>
   : scanState==='failed' ? <span role="alert">{t('permissions.error')}</span>
   : <NativeWindowNotice result={diagnostics} interact={true}/>}
 </div>;
 const windowPicker = active&&activeTarget
  ? <span className="desktop-observed-target" title={targetLabel(activeTarget)}>{targetLabel(activeTarget)}</span>
  : <div className="native-window-picker"><Select label={t('permissions.window')} value={selected} disabled={busy}
    options={[{value:'',label:t('permissions.selectWindow')},...targets.map(x=>({value:targetKey(x),label:targetLabel(x)}))]}
    onChange={selectWindow} onOpen={mode==='inline'?()=>void refreshPicker():undefined} popupNotice={pickerNotice} reopenKey={reopenKey}
    hideOptions={mode==='inline'&&scanState!=='idle'}/></div>;
 const notices = <>
  {!live&&target&&<p className="extension-detail-notice">{t('computer.windowReady')}</p>}
  {(actionFailed||statusState==='failed')&&<p role="alert" className="extension-detail-notice">{t(actionFailed?'permissions.error':'config.unavailable')}</p>}
 </>;
 if(mode==='inline'){
  const failed=actionFailed||statusState==='failed'||stopUnconfirmed;
  const text=t(actionFailed?'permissions.error':statusState==='failed'?'config.unavailable':statusState==='loading'?'config.loading'
   :stopUnconfirmed?'plugins.stopUnknown':active?'browser.connected':'browser.disconnected');
  return <FieldRow label={t('config.window')} hint={t('permissions.existingHint')}>
   {windowPicker}
   <span className="browser-connection" data-state={failed?'error':statusState==='loading'?'loading':active?'on':'off'}
    role={failed?'alert':'status'} title={text}><span aria-hidden="true"/><span>{text}</span></span>
   {runButton}
  </FieldRow>;
 }
 const body=<div className="extension-detail">
  <header className="extension-detail-header"><div>{mode==='settings'&&<h3>{t(plugin+'.title')}</h3>}<span className={`extension-detail-status${active?' is-active':''}`}>{status}</span></div>{mode==='settings'&&<DialogBackButton onClick={()=>setOpen(false)}/>}</header>
  <section className="extension-detail-section">
   <FieldRow label={t('permissions.window')} hint={t('permissions.existingHint')}>
    {windowPicker}
   </FieldRow>
   {findButton&&<div className="extension-detail-actions">{findButton}</div>}
   <NativeWindowNotice result={diagnostics} interact={true}/>

   <div className="extension-detail-actions">{runButton}</div>
  </section>
  {plugin==='computer'&&<details className="extension-detail-section extension-detail-advanced" open><summary>{t('computer.companionship')} <Hint text={t('computer.behaviorHint')}/></summary>
   <FieldRow label={t('computer.proactive')}><Switch title={t('computer.proactive')} disabled={busy} on={computer.status?.proactive??false} onChange={v=>void run(async()=>{await configureComputer(v,computer.status?.reactions??false);})}/></FieldRow>
   <FieldRow label={t('computer.reactions')}><Switch title={t('computer.reactions')} disabled={busy} on={computer.status?.reactions??false} onChange={v=>void run(async()=>{await configureComputer(computer.status?.proactive??false,v);})}/></FieldRow>
  </details>}
  {mode==='settings'&&<details className="extension-detail-section extension-detail-advanced"><summary>{t('desktopAccess.blocklist')}</summary><AppPermissions manage/></details>}
  {notices}
 </div>;
 if(mode!=='settings')return body;
 return <ExtensionCard id={plugin} title={t(plugin+'.title')} status={status} running={active} onConfigure={()=>setOpen(true)}>{open&&<Modal className="extension-modal" label={t(plugin+'.title')} onClose={()=>setOpen(false)}>{body}</Modal>}</ExtensionCard>;
}
