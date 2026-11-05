import {useEffect,useRef,useState} from 'react';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {clampPage} from '../../lib/paging';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';
import Modal from '../../ui/Modal';
import Pager from '../../ui/Pager';
import Switch from '../../ui/Switch';
import OfficialPlugins from './OfficialPlugins';
import ComputerCompanion from './ComputerCompanion';
import BrowserCompanion from './BrowserCompanion';
import MinecraftCompanion from './MinecraftCompanion';
import '../../styles/plugin-library.css';
type Installed={manifest:{id:string;name:string;description:string;version:string;capabilities:string[]};enabled:boolean;runtimeStatus?:string};
const endpoint='/api/extensions/plugins';
export default function PluginLibrary({active}:{active:boolean}){
 const t=useT(),file=useRef<HTMLInputElement>(null),toolbar=useRef<HTMLDivElement>(null);
 const [plugins,setPlugins]=useState<Installed[]>([]),[query,setQuery]=useState(''),[page,setPage]=useState(0);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 const [review,setReview]=useState<Installed|null>(null),[removing,setRemoving]=useState<Installed|null>(null);
 const refresh=async()=>{const result=await apiJson<{plugins:Installed[]}>(endpoint);setPlugins(result.plugins);setLoaded(true);};
 useEffect(()=>{if(!active)return;const controller=new AbortController();void apiJson<{plugins:Installed[]}>(endpoint,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted){setPlugins(result.plugins);setLoaded(true);}}).catch(()=>{if(!controller.signal.aborted)setError('plugins.error');});return()=>controller.abort();},[active]);

 const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await action();await refresh();setReview(null);setRemoving(null);}catch{setError('plugins.error');try{await refresh();}catch{/* Retain the action error. */}}finally{setBusy(false);}};
 const importFile=async(input:File)=>{if(input.size>2*1024*1024){setError('plugins.fileLarge');return;}await run(async()=>apiJson(endpoint,jsonInit('POST',JSON.parse(await input.text()))));};
 const needle=query.trim().toLocaleLowerCase();
 const rows:[string,Installed|null][]=[['official-qq',null],['official-computer',null],['official-browser',null],['official-minecraft',null],...plugins.map(item=>[item.manifest.id,item] as [string,Installed])];
 const matches=rows.filter(([id,item])=>(item?`${item.manifest.name} ${item.manifest.id}`:id==='official-qq'?'QQ':t(id==='official-computer'?'computer.title':id==='official-browser'?'browser.title':'minecraft.title')).toLocaleLowerCase().includes(needle));
 const paging=clampPage(page,matches.length,4),shown=matches.slice(paging.page*4,(paging.page+1)*4);
 return <section className="plugin-library panel panel-stack">
  <div className="panel-title-row"><h3 className="opt-group">{t('plugins.title')}</h3><Hint text={t('plugins.importHint')} side="down"/></div>
  <div ref={toolbar} className="list-toolbar plugin-library-toolbar"><input className="list-search" aria-label={t('plugins.search')} placeholder={t('plugins.search')} value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><Button disabled={busy} onClick={()=>file.current?.click()}>{t('plugins.importFile')}</Button><input ref={file} type="file" accept=".json,application/json" hidden onChange={e=>{const selected=e.target.files?.[0];e.target.value='';if(selected)void importFile(selected);}}/></div>
  {error&&<p role="alert">{t(error)}</p>}
  {!loaded&&!error&&<p role="status">{t('plugins.loading')}</p>}
  <div className="plugin-library-items">{shown.map(([id,item])=>item?<article className="plugin-library-card" key={id}>
   <div><strong>{item.manifest.name}</strong><span className="muted">{item.manifest.version}</span></div>
   <p>{item.manifest.description}</p>{item.runtimeStatus==='stop-unconfirmed'&&<p role="alert">{t('plugins.stopUnknown')}</p>}<div className="plugin-library-actions"><Switch title={item.manifest.name} on={item.enabled} disabled={busy||item.runtimeStatus==='stop-unconfirmed'} onChange={enabled=>enabled?setReview(item):void run(()=>apiJson(`${endpoint}/${encodeURIComponent(id)}`,jsonInit('PATCH',{enabled:false})))}/>{item.runtimeStatus==='stop-unconfirmed'&&<Button disabled={busy} onClick={()=>void run(()=>apiJson(`${endpoint}/${encodeURIComponent(id)}`,jsonInit('PATCH',{enabled:false})))}>{t('plugins.retryStop')}</Button>}<Button variant="ghost" onClick={()=>setReview(item)}>{t('plugins.details')}</Button><Button variant="ghost" disabled={busy} onClick={()=>setRemoving(item)}>{t('plugins.remove')}</Button></div>
  </article>:id==='official-qq'?<OfficialPlugins key={id} active={active}/>:id==='official-computer'?<ComputerCompanion key={id}/>:id==='official-browser'?<BrowserCompanion key={id}/>:<MinecraftCompanion key={id}/>)}{!matches.length&&<p className="muted">{t('plugins.empty')}</p>}</div>
  <Pager page={paging.page} pages={paging.pages} onChange={setPage}/>
  {active&&review&&<Modal className="extension-modal" label={t('plugins.details')} onClose={()=>{if(!busy)setReview(null);}}><h3>{review.manifest.name}</h3><p>{review.manifest.description}</p><p>{t('plugins.trust')}</p><ul>{review.manifest.capabilities.map(cap=><li key={cap}>{cap}</li>)}</ul>{error&&<p role="alert">{t(error)}</p>}<div className="plugin-library-actions"><Button disabled={busy} variant="ghost" onClick={()=>setReview(null)}>{t('plugins.cancel')}</Button>{!review.enabled&&review.runtimeStatus!=='stop-unconfirmed'&&<Button disabled={busy} onClick={()=>void run(()=>apiJson(`${endpoint}/${encodeURIComponent(review.manifest.id)}`,jsonInit('PATCH',{enabled:true,trustAccepted:true})))}>{t('plugins.enable')}</Button>}</div></Modal>}
  {active&&removing&&<Modal className="extension-modal" label={t('plugins.remove')} onClose={()=>{if(!busy)setRemoving(null);}}><h3>{removing.manifest.name}</h3><p>{t('plugins.removeAsk')}</p>{error&&<p role="alert">{t(error)}</p>}<div className="plugin-library-actions"><Button disabled={busy} variant="ghost" onClick={()=>setRemoving(null)}>{t('plugins.cancel')}</Button><Button disabled={busy} onClick={()=>void run(()=>apiJson(`${endpoint}/${encodeURIComponent(removing.manifest.id)}`,{method:'DELETE'}))}>{t('plugins.remove')}</Button></div></Modal>}
 </section>;
}
