import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import Switch from '../../ui/Switch';
type Status={starting?:boolean;prepared:boolean;running:boolean;authenticated:boolean;remembered?:boolean;loginAvailable:boolean;profile?:{name:string;id:string};reason?:string};
type Device={userCode:string;verificationUri:string;expiresIn:number;expiresAt?:number};
export default function MinecraftCompanion(){
 const t=useT(),meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [status,setStatus]=useState<Status|null>(null),[device,setDevice]=useState<Device|null>(null);
 const [client,setClient]=useState(''),[resources,setResources]=useState(''),[server,setServer]=useState(''),[world,setWorld]=useState('');
 const attempt=useRef(0);
 const [launching,setLaunching]=useState(false),[stopping,setStopping]=useState(false);
 const [chat,setChat]=useState(false),[move,setMove]=useState(false);
 const read=async()=>setStatus(await apiJson<Status>('/api/minecraft/managed/status'));
 useEffect(()=>{void read().catch(()=>setError('minecraft.error'));},[open,meeting.state,meeting.attention.focus]);
 useEffect(()=>{if(!status?.running&&!status?.starting&&!launching)return;let disposed=false;const timer=setInterval(()=>{void apiJson<Status>('/api/minecraft/managed/status').then(next=>{if(!disposed)setStatus(next);}).catch(()=>{if(!disposed)setError('minecraft.error');});},2000);return()=>{disposed=true;clearInterval(timer);};},[status?.running,status?.starting,launching]);
 useEffect(()=>{
  if(!open||!device)return;
  let cancelled=false;const serial=attempt.current;let timer:ReturnType<typeof setTimeout>;
  const deadline=device.expiresAt??Date.now()+device.expiresIn*1000;
  const poll=async()=>{
   if(cancelled||serial!==attempt.current)return;
   if(Date.now()>=deadline){setDevice(null);setError('minecraft.loginExpired');return;}
   try{
    const result=await apiJson<{status?:string;authenticated?:boolean}>('/api/minecraft/auth/poll',jsonInit('POST',{}));
    if(cancelled||serial!==attempt.current)return;
    if(result.authenticated||result.status==='authenticated'){
     const next=await apiJson<Status>('/api/minecraft/managed/status');
     if(cancelled||serial!==attempt.current)return;
     setStatus(next);setDevice(null);return;
    }
   }catch{if(cancelled||serial!==attempt.current)return;setError('minecraft.error');setDevice(null);return;}
   timer=setTimeout(()=>void poll(),5000);
  };
  timer=setTimeout(()=>void poll(),5000);
  return()=>{cancelled=true;clearTimeout(timer);};
 },[open,device]);
 const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await fn();await read();}catch{setError('minecraft.error');await read().catch(()=>{});}finally{setBusy(false);}};
 const post=(path:string,body:unknown={})=>apiJson('/api/minecraft/'+path,jsonInit('POST',body));
 const locked=busy||status?.running;
 return <article className="plugin-library-card"><strong>{t('minecraft.title')}</strong><p>{t('minecraft.description')}</p><div className="plugin-library-actions"><span>{t(status?.running?'minecraft.running':'minecraft.stopped')}</span><Button variant="ghost" onClick={()=>setOpen(true)}>{t('minecraft.configure')}</Button></div>
 {open&&<Modal className="extension-modal" label={t('minecraft.title')} onClose={()=>setOpen(false)}><div className="extension-modal-heading"><h3>{t('minecraft.title')}</h3><Button variant="ghost" aria-label={t('minecraft.dismiss')} onClick={()=>setOpen(false)}>×</Button></div>
 <p>{t('minecraft.requirements')}</p><p>{t('minecraft.joinHint')}</p><p>{t(status?.prepared?'minecraft.resourcesReady':'minecraft.resourcesMissing')}</p>
 {!status?.prepared&&<div className="list-toolbar"><details><summary>{t('minecraft.advancedResources')}</summary><input className="list-search" aria-label={t('minecraft.resources')} value={resources} onChange={e=>setResources(e.target.value)} disabled={locked}/></details><Button disabled={locked} onClick={()=>void run(async()=>{await post('managed/prepare',resources.trim()?{resources:resources.trim()}:{});})}>{t('minecraft.prepare')}</Button></div>}
 <p>{status?.profile?.name??t('minecraft.signedOut')}</p>{status?.remembered&&!status.authenticated&&<p>{t('minecraft.remembered')}</p>}
 {!status?.authenticated&&!status?.remembered&&<><label style={{display:"grid",gap:".4rem"}}>{t('minecraft.clientId')}<input className="list-search" value={client} onChange={e=>setClient(e.target.value)} disabled={locked}/></label><p className="muted">{t('minecraft.clientHint')}</p><Button disabled={locked||!client.trim()} onClick={()=>void run(async()=>{const serial=++attempt.current;setDevice(null);const result=await apiJson<Device>('/api/minecraft/auth/begin',jsonInit('POST',{clientId:client.trim()}));if(serial===attempt.current)setDevice({...result,expiresAt:Date.now()+result.expiresIn*1000});})}>{t('minecraft.login')}</Button></>}
 {device&&<div role="status"><p>{t('minecraft.deviceHint')}</p><strong>{device.userCode}</strong>{/^https:\/\/(?:www\.)?microsoft\.com\//.test(device.verificationUri)&&<p><a href={device.verificationUri} target="_blank" rel="noreferrer">{device.verificationUri}</a></p>}<p>{t('minecraft.waitingLogin')}</p></div>}
 {(status?.authenticated||status?.remembered)&&<Button variant="ghost" disabled={busy} onClick={()=>void run(async()=>{++attempt.current;setDevice(null);await post('auth/logout');})}>{t('minecraft.logout')}</Button>}
 <label style={{display:"grid",gap:".4rem"}}>{t('minecraft.server')}<input className="list-search" value={server} disabled={locked} onChange={e=>setServer(e.target.value)}/></label><label style={{display:"grid",gap:".4rem"}}>{t('minecraft.world')}<input className="list-search" value={world} disabled={locked} onChange={e=>setWorld(e.target.value)}/></label>
 <p>{t('minecraft.observe')}</p><div className="plugin-library-actions"><span>{t('minecraft.chat')}</span><Switch title={t('minecraft.chat')} on={chat} onChange={setChat} disabled={locked}/><span>{t('minecraft.move')}</span><Switch title={t('minecraft.move')} on={move} onChange={setMove} disabled={locked}/></div>
 <div className="plugin-library-actions"><Button disabled={busy||status?.running||!status?.prepared||(!status.authenticated&&!status.remembered)||meeting.state!=='active'||!world.trim()||!server.trim()} onClick={()=>void run(async()=>{setLaunching(true);try{await post('managed/start',{...meetingIdentity(),server:server.trim(),world:world.trim(),permissions:['game.observe',...(chat?['game.chat']:[]),...(move?['game.move']:[])]});}finally{setLaunching(false);}})}>{t('minecraft.start')}</Button><Button variant="ghost" disabled={stopping||(!status?.running&&!status?.starting&&!launching)} onClick={()=>{setStopping(true);void post('managed/stop').then(read).catch(()=>setError('minecraft.error')).finally(()=>setStopping(false));}}>{t('minecraft.stop')}</Button></div>
 {meeting.state!=='active'&&<p>{t('computer.requiresBoot')}</p>}{status?.reason&&<p role="status">{status.reason}</p>}{error&&<p role="alert">{t(error)}</p>}
 </Modal>}</article>;
}
