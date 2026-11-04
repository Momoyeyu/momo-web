import {useEffect,useState,useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';
import Modal from '../../ui/Modal';
import Switch from '../../ui/Switch';
type Status={active:boolean;generation:number;permissions:string[];allowedHosts?:string[]};
export default function BrowserCompanion(){
 const t=useT(),meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const [status,setStatus]=useState<Status|null>(null),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [host,setHost]=useState(''),[hosts,setHosts]=useState<string[]>([]),[interact,setInteract]=useState(false),[url,setUrl]=useState(''),[image,setImage]=useState('');
 const read=async()=>{const next=await apiJson<Status>('/api/browser/status');setStatus(next);setHosts(next.allowedHosts??[]);setInteract(next.permissions.includes('interact'));};
 useEffect(()=>{void read().catch(()=>setError('browser.error'));},[open,meeting.state,meeting.attention.focus]);
 useEffect(()=>{if(!status?.active)return;let disposed=false;const timer=setInterval(()=>{void apiJson<Status>('/api/browser/status').then(next=>{if(disposed)return;setStatus(next);if(!next.active)setImage('');}).catch(()=>{if(!disposed)setError('browser.error');});},3000);return()=>{disposed=true;clearInterval(timer);};},[status?.active]);
 const run=async(fn:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch{setError('browser.error');}finally{setBusy(false);}};
 const addHost=()=>{try{const input=host.trim().toLowerCase();if(!input||/[/:@?#*\s]/.test(input))throw Error();const normalized=new URL('https://'+input).hostname;if(!normalized.includes('.')||/^\d+[.\d]*$/.test(normalized)||hosts.length>=20)throw Error();setHosts([...new Set([...hosts,normalized])]);setHost('');setError('');}catch{setError('browser.invalidHost');}};
 const start=()=>run(async()=>{const owner=meetingIdentity();if(!owner)throw Error();setStatus(await apiJson<Status>('/api/browser/start',jsonInit('POST',{...owner,permissions:interact?['observe','interact']:['observe'],allowedHosts:hosts})));});
 const stop=()=>run(async()=>{await apiJson('/api/browser/stop',{method:'POST'});setImage('');await read();});
 const visit=()=>run(async()=>{const owner=meetingIdentity();if(!owner||!status?.active)throw Error();const result=await apiJson<{data:string}>('/api/browser/open',jsonInit('POST',{...owner,generation:status.generation,url}));setImage('data:image/png;base64,'+result.data);});
 return <article className="plugin-library-card"><div><strong>{t('browser.title')}</strong><Hint text={t('browser.hint')} side="down"/></div><div className="plugin-library-actions"><span className="muted">{t(status?.active?'browser.active':'browser.inactive')}</span><Button variant="ghost" onClick={()=>setOpen(true)}>{t('browser.configure')}</Button></div>
 {open&&<Modal className="extension-modal" label={t('browser.title')} onClose={()=>setOpen(false)}><div className="extension-modal-heading"><h3>{t('browser.title')}</h3><Button variant="ghost" aria-label={t('browser.dismiss')} onClick={()=>setOpen(false)}>×</Button></div><p>{t('browser.readOnly')}</p><div className="plugin-library-actions"><span>{t('browser.interact')}</span><Hint text={t('browser.interactHint')} side="down"/><Switch on={interact} disabled={busy||status?.active} title={t('browser.interact')} onChange={setInteract}/></div>
 <label className="browser-host-label">{t('browser.hosts')}</label><div className="list-toolbar"><input className="list-search" aria-label={t('browser.hosts')} placeholder="example.com" value={host} disabled={busy||status?.active} onChange={e=>setHost(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();addHost();}}}/><Button disabled={busy||status?.active} onClick={addHost}>{t('browser.add')}</Button></div>
 <div className="browser-hosts">{hosts.map(item=><Button key={item} variant="ghost" disabled={busy||status?.active} onClick={()=>setHosts(hosts.filter(value=>value!==item))} title={t('browser.removeHost')}>{item} ×</Button>)}</div>
 <div className="plugin-library-actions"><Button disabled={busy||status?.active||meeting.state!=='active'||hosts.length===0} onClick={()=>void start()}>{t('browser.start')}</Button><Button variant="ghost" disabled={busy||!status?.active} onClick={()=>void stop()}>{t('browser.stop')}</Button></div>
 {status?.active&&<form className="list-toolbar" onSubmit={e=>{e.preventDefault();void visit();}}><input className="list-search" type="url" required value={url} onChange={e=>setUrl(e.target.value)} aria-label={t('browser.url')} placeholder="https://example.com/"/><Button type="submit" disabled={busy}>{t('browser.visit')}</Button></form>}
 {image&&<img className="browser-preview" src={image} alt={t('browser.preview')}/>}{error&&<p role="alert">{t(error)}</p>}{meeting.state!=='active'&&<p>{t('computer.requiresBoot')}</p>}
 </Modal>}</article>;
}
