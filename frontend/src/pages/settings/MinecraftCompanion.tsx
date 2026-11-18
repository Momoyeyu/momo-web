import {minecraftSnapshot,subscribeMinecraft,readMinecraftStatus} from '../../services/minecraftClient';
import {minecraftFailureKey,minecraftTaskVisible,minecraftTaskStateKey} from '../../services/minecraftFailure';
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {getSettings,subscribe,updateGeneral} from '../../lib/store';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {useActivities} from '../../services/extensionActivities';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import {desktopWindowAvailable} from '../../services/desktopWindow';
import {navigate} from '../../router';
import ExtensionCard from './ExtensionCard';
import Button from '../../ui/Button';
import FieldRow from '../../ui/FieldRow';
import Hint from '../../ui/Hint';
import Modal from '../../ui/Modal';
import Select from '../../ui/Select';
import Switch from '../../ui/Switch';

type Session={id:string;pid:number;world:string;account:string;playerName:string;worldName?:string;ready:boolean};
export default function MinecraftCompanion({mode='settings',onDismiss}:{mode?:'settings'|'activity';onDismiss?:()=>void}){
 const t=useT(),enabled=useActivities().minecraft,meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[active,setActive]=useState(false);
 const [sessions,setSessions]=useState<Session[]>([]),[selected,setSelected]=useState(''),[path,setPath]=useState('');
 const preferences=useSyncExternalStore(subscribe,getSettings).general;
 const game=useSyncExternalStore(subscribeMinecraft,minecraftSnapshot);
 const gameplay=preferences.minecraftPlay===true;
 const mounted=useRef(false),operation=useRef(false),request=useRef<AbortController|null>(null);
 const read=useCallback(async(force=false)=>{
  request.current?.abort();
  const controller=new AbortController();request.current=controller;
  try{
   const [status,list]=await Promise.all([
    readMinecraftStatus(force),
    apiJson<{sessions:Session[]}>('/api/minecraft/sessions',{signal:controller.signal}),
   ]);
   if(!mounted.current||controller.signal.aborted)return;
   setActive(Boolean(status.active));setSessions(list.sessions);
   setSelected(value=>list.sessions.some(s=>s.id===value&&s.ready)?value:'');
  }catch(error){if(!controller.signal.aborted)throw error;}
  finally{if(request.current===controller)request.current=null;}
 },[]);
 useEffect(()=>{
  mounted.current=true;
  const refresh=()=>{if(!operation.current&&!request.current)void read().catch(()=>{if(mounted.current)setError(true);});};
  refresh();const timer=setInterval(refresh,3000);
  return()=>{mounted.current=false;clearInterval(timer);request.current?.abort();request.current=null;};
 },[read]);
 const run=async(fn:()=>Promise<unknown>)=>{
  if(operation.current)return;operation.current=true;setBusy(true);setError(false);request.current?.abort();
  try{await fn();if(mounted.current)await read(true);}
  catch{if(mounted.current)setError(true);}
  finally{operation.current=false;if(mounted.current)setBusy(false);}
 };
 const current=active&&game?.sessionId?sessions.find(s=>s.id===game.sessionId):sessions.find(s=>s.id===selected);
 const start=async()=>{
  if(!current?.ready)return;
  await apiJson('/api/minecraft/attach',jsonInit('POST',{
   ...meetingIdentity(),sessionId:current.id,world:current.world,account:current.account,
   permissions:['game.observe',...(gameplay?['game.chat','game.move','game.modify']:[])],
  }));
  if(!gameplay||!desktopWindowAvailable()||!mounted.current)return;
  await readMinecraftStatus(true);
  onDismiss?.();
  if(mode==='settings')navigate('chat');
 };
 const evidence=game?.goalEvidence?.at(-1);
 const evidenceSkill=evidence?.placed?.length?'build':evidence?.gains?.length?(evidence.skill==='craft'?'craft':'gather'):evidence?.mined?.length?'mine':'attack';
 const evidenceRows=evidence?.placed?.length?evidence.placed:evidence?.gains?.length?evidence.gains:evidence?.mined||[];
 const evidenceCount=evidenceRows.reduce((total,item)=>total+item.count,0)||(evidence?.defeated||0);
 const body=<div className="extension-detail">
  <header className="extension-detail-header">
   <div><h3>{t('minecraft.title')}</h3><span className="extension-detail-status">{t(active?'minecraft.running':'minecraft.stopped')}</span></div>
   {(mode==='settings'||onDismiss)&&<button type="button" className="icon-btn" aria-label={t('minecraft.dismiss')} onClick={mode==='settings'?()=>setOpen(false):onDismiss}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button>}
  </header>
  <section className="extension-detail-section">
   <FieldRow label={t('minecraft.session')} hint={t('minecraft.existingHint')}>
    {busy||active?<span>{current?`${current.playerName} · ${current.worldName||current.world}`:t(active?'minecraft.running':'minecraft.selectSession')}</span>:<Select value={selected} options={[{value:'',label:t('minecraft.selectSession')},...sessions.filter(s=>s.ready).map(s=>({value:s.id,label:`${s.playerName} · ${s.worldName||s.world}`}))]} onChange={setSelected}/>}
   </FieldRow>
   {(!active||mode==='settings')&&<div className="extension-detail-actions"><Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{})}>{t('minecraft.refresh')}</Button></div>}
  </section>
  <section className="extension-detail-section">
   {(!active||mode==='settings')&&<><h4>{t('minecraft.permissions')} <Hint text={t('minecraft.permissionsHint')}/></h4>
   <FieldRow label={t('minecraft.play')}><Switch title={t('minecraft.play')} on={preferences.minecraftPlay===true} onChange={value=>updateGeneral({minecraftPlay:value})} disabled={busy||active}/></FieldRow></>}
   <div className="extension-detail-actions">
    {(!active||mode==='settings')&&<Button disabled={!enabled||busy||active||!current?.ready||meeting.state!=='active'} onClick={()=>void run(start)}>{t('minecraft.start')}</Button>}
    {active&&game?.permissions?.includes('game.modify')&&<Button variant="ghost" disabled={busy} onClick={()=>void run(()=>apiJson('/api/minecraft/tasks',jsonInit('POST',{...meetingIdentity(),generation:game!.generation,action:game?.paused?'resume':'pause'})))}>{t(game?.paused?'minecraft.resumePlay':'minecraft.pausePlay')}</Button>}
    {(active||mode==='settings')&&<Button variant="ghost" disabled={busy||!active} onClick={()=>void run(()=>apiJson('/api/minecraft/stop',jsonInit('POST',{})))}>{t('minecraft.stop')}</Button>}
   </div>
  </section>
  {active&&game&&<section className="extension-detail-section game-progress" aria-live="polite">
   {game.goal&&<div className="game-goal"><span>{t('minecraft.currentGoal')}</span><strong>{game.goal.title}</strong></div>}
   {evidence&&evidenceCount>0&&Number.isFinite(evidenceCount)&&<div className="game-task"><span>{t('minecraft.actualProgress')}</span><span>{t(`minecraft.skill.${evidenceSkill}`)} · {evidenceCount}</span></div>}
   {game.tasks.filter(task=>minecraftTaskVisible(task.state,task.reason,task.skill)).slice(-3).map(task=><div className="game-task" key={task.taskId}><span>{t(`minecraft.skill.${task.progress?.action?.skill||task.progress?.skill||task.skill}`)}</span><span>{t(minecraftTaskStateKey(task.state,task.reason))}</span>{['failed','cancelled'].includes(task.state)&&<Hint text={t(minecraftFailureKey(task.reason))}/>}</div>)}
  </section>}
  {mode==='settings'&&<details className="extension-detail-section extension-detail-advanced"><summary>{t('minecraft.install')}</summary><FieldRow label={t('minecraft.instancePath')} hint={t('minecraft.installHint')}><input type="text" value={path} onChange={e=>setPath(e.target.value)} disabled={busy}/></FieldRow><div className="extension-detail-actions"><Button disabled={busy||!path.trim()} onClick={()=>void run(()=>apiJson('/api/minecraft/install',jsonInit('POST',{instancePath:path.trim()})))}>{t('minecraft.install')}</Button></div></details>}
  {meeting.state!=='active'&&<p className="extension-detail-notice">{t('computer.requiresBoot')}</p>}
  {error&&<p role="alert" className="extension-detail-notice">{t('minecraft.error')}</p>}
 </div>;
 if(mode==='activity')return body;
 return <ExtensionCard id="minecraft" title={t('minecraft.title')} status={t(active?'minecraft.running':'minecraft.stopped')} onConfigure={()=>setOpen(true)}>{open&&<Modal className="extension-modal" label={t('minecraft.title')} onClose={()=>setOpen(false)}>{body}</Modal>}</ExtensionCard>;
}
