import {useEffect,useState,useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {useActivities} from '../../services/extensionActivities';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import ExtensionCard from './ExtensionCard';
import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import Switch from '../../ui/Switch';
type Session={id:string;pid:number;world:string;account:string;playerName:string;ready:boolean};
export default function MinecraftCompanion(){
 const t=useT(),enabled=useActivities().minecraft,meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false),[active,setActive]=useState(false);
 const [sessions,setSessions]=useState<Session[]>([]),[selected,setSelected]=useState(''),[path,setPath]=useState(''),[chat,setChat]=useState(false),[move,setMove]=useState(false);
 const read=async()=>{const [status,list]=await Promise.all([apiJson<{active?:boolean;connected?:boolean}>('/api/minecraft/status'),apiJson<{sessions:Session[]}>('/api/minecraft/sessions')]);setActive(Boolean(status.active||status.connected));setSessions(list.sessions);};
 useEffect(()=>{let disposed=false;const refresh=()=>{if(!disposed)void read().catch(()=>setError(true));};refresh();const timer=setInterval(refresh,3000);return()=>{disposed=true;clearInterval(timer);};},[open,meeting.state]);
 const run=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError(false);try{await fn();await read();}catch{setError(true);}finally{setBusy(false);}};
 const current=sessions.find(s=>s.id===selected);
 return <ExtensionCard id="minecraft" title={t('minecraft.title')} status={t(active?'minecraft.running':'minecraft.stopped')} onConfigure={()=>setOpen(true)}>{open&&<Modal className="extension-modal" label={t('minecraft.title')} onClose={()=>setOpen(false)}><div className="extension-modal-heading"><h3>{t('minecraft.title')}</h3><Button variant="ghost" aria-label={t('minecraft.dismiss')} onClick={()=>setOpen(false)}>×</Button></div><p>{t('minecraft.existingHint')}</p>
 <label>{t('minecraft.session')}<select className="list-search" value={selected} disabled={busy||active} onChange={e=>setSelected(e.target.value)}><option value="">{t('minecraft.selectSession')}</option>{sessions.map(s=><option key={s.id} value={s.id} disabled={!s.ready}>{s.playerName} · {s.world}</option>)}</select></label>
 <div className="plugin-library-actions"><span>{t('minecraft.chat')}</span><Switch title={t('minecraft.chat')} on={chat} onChange={setChat} disabled={busy||active}/><span>{t('minecraft.move')}</span><Switch title={t('minecraft.move')} on={move} onChange={setMove} disabled={busy||active}/></div>
 <div className="plugin-library-actions"><Button disabled={!enabled||busy||active||!current?.ready||meeting.state!=='active'} onClick={()=>void run(()=>apiJson('/api/minecraft/attach',jsonInit('POST',{...meetingIdentity(),sessionId:current!.id,world:current!.world,account:current!.account,permissions:['game.observe',...(chat?['game.chat']:[]),...(move?['game.move']:[])]})))}>{t('minecraft.start')}</Button><Button variant="ghost" disabled={busy||!active} onClick={()=>void run(()=>apiJson('/api/minecraft/stop',jsonInit('POST',{})))}>{t('minecraft.stop')}</Button></div>
 <details><summary>{t('minecraft.install')}</summary><label>{t('minecraft.instancePath')}<input className="list-search" value={path} onChange={e=>setPath(e.target.value)} disabled={busy}/></label><Button disabled={busy||!path.trim()} onClick={()=>void run(()=>apiJson('/api/minecraft/install',jsonInit('POST',{instancePath:path.trim()})))}>{t('minecraft.install')}</Button></details>
 {meeting.state!=='active'&&<p>{t('computer.requiresBoot')}</p>}{error&&<p role="alert">{t('minecraft.error')}</p>}</Modal>}</ExtensionCard>;
}
