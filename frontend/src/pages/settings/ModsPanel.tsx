import {useEffect,useRef,useState} from 'react';
import {useT} from '../../i18n';
import {jsonInit} from '../../services/http';
import {runtimeFetch} from '../../services/runtime';
import {refreshActivities} from '../../services/extensionActivities';
import {applyModChange,refreshMods,useMods,type InstalledMod} from '../../services/mods';
import Pager from '../../ui/Pager';
import {clampPage} from '../../lib/paging';
import FieldRow from '../../ui/FieldRow';
import Button from '../../ui/Button';
import Modal from '../../ui/Modal';
import OfficialPlugins from './OfficialPlugins';
import MinecraftCompanion from './MinecraftCompanion';

const official = {'momo.qq':'QQ','momo.minecraft':'Minecraft'};
type Selection = {id:string; mode:'manage'|'install'|'remove'} | {file:File};

export default function ModsPanel(){
  const t=useT(), mods=useMods(), file=useRef<HTMLInputElement>(null);
  const [selection,select]=useState<Selection|null>(null);
  const [page,setPage]=useState(0);
  const [query,setQuery]=useState('');
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const working=useRef(false), code=(key:string)=>t('modManager.'+key);
  const item=selection && 'id' in selection ? mods.find(m=>m.id===selection.id) : undefined;
  const load=()=>refreshMods().catch(()=>setError('listError'));
  useEffect(()=>{void load();},[]);
  function open(next:Selection|null){if(!working.current){setError('');select(next);}}
  async function run(url:string, init:RequestInit, next:Selection|null){
    if(working.current)return;
    working.current=true;setBusy(true);setError('');
    try{
      const response=await runtimeFetch(url,init);
      if (!response.ok) {
        const {detail}=await response.json().catch(()=>({}));
        const reason=String(detail || '');
        const key=/incompatible platform|incompatible momo api/i.test(reason)?'incompatible'
          : /checksum|signature|digest/i.test(reason)?'integrity'
          : /download failed/i.test(reason)?'download'
          : response.status===413?'size':'actionError';
        setError(key);
        await Promise.allSettled([refreshMods(),refreshActivities()]);
        return;
      }
      if(init.method==='DELETE' && selection && 'id' in selection)applyModChange(selection.id,null);
      else{
        const record=await response.json() as InstalledMod;
        applyModChange(record.id,record);
      }
      select(next);
      try{await refreshMods();}
      catch{select(null);setError('listError');return;}
      await refreshActivities().catch(()=>{});
    }catch{setError('actionError');}
    finally{working.current=false;setBusy(false);}
  }
  function button(label:string,onClick:()=>void,disabled=false){
    return <Button className="config-action" size="sm" variant="ghost" disabled={disabled||busy} onClick={onClick}>{code(label)}</Button>;
  }
  const name=item?.name??(selection&&'id' in selection?official[selection.id as keyof typeof official]:'');
  const entries=new Map<string,string>(Object.entries(official));
  mods.forEach(m=>entries.set(m.id,m.name));
  const filterable=entries.size>5;
  const list=[...entries].filter(([id,label])=>!filterable||(id+' '+label).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const paging=clampPage(page,list.length,5);
  return <>
    <FieldRow label={code('local')}><span/>{button('import',()=>file.current?.click())}
      <input ref={file} type="file" hidden accept=".momomod" onChange={e=>{const picked=e.target.files?.[0];e.target.value='';if(picked)open({file:picked});}}/>
    </FieldRow>
    {filterable&&<input type="search" className="list-search" value={query} aria-label={code('search')} placeholder={code('search')} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>}
    {list.slice(paging.page*5,paging.page*5+5).map(([id,label])=>{
      const installed=mods.find(m=>m.id===id);
      return <FieldRow key={id} label={label}><span className="muted">{code(installed?(installed.enabled?'enabled':'disabled'):'absent')}</span>
        {button(installed?'manage':'install',()=>open({id,mode:installed?'manage':'install'}))}
      </FieldRow>;
    })}
    {filterable&&<Pager page={paging.page} pages={paging.pages} onChange={setPage}/>}
    {!selection&&error&&<div role="alert">{code(error)} {button('retry',()=>{setError('');void load();})}</div>}
    {selection&&<Modal label={'file' in selection?code('import'):name} onClose={()=>open(null)} className="extension-modal">
      <div className="extension-detail"><h3>{'file' in selection?code('import'):name}</h3>
      {'file' in selection ? <><p>{selection.file.name}</p><p>{code('importHint')}</p>
        {button('import',()=>{const data=new FormData();data.append('file',selection.file);void run('/api/mods',{method:'POST',body:data},null);})}</>
      : selection.mode==='install' ? <><p>{code('officialHint')}</p>
        {button('install',()=>void run('/api/mods/official/'+selection.id,{method:'POST'},{id:selection.id,mode:'manage'}))}</>
      : selection.mode==='remove' ? <><p>{code('removeHint')}</p>
        {button('remove',()=>void run('/api/mods/'+selection.id,{method:'DELETE'},null))}</>
      : item && <><p>{item.version} · {code(item.enabled?'enabled':'disabled')}</p>
        <p>{code(item.source==='official'?'officialSource':'localSource')} · {(item.platforms??[]).map(platform=>platform==='*'?code('allPlatforms'):platform).join(', ')}</p>
        <div className="extension-detail-actions">{button(item.enabled?'disable':'enable',()=>void run('/api/mods/'+item.id,jsonInit('PATCH',{enabled:!item.enabled}),selection))}
        {button('remove',()=>open({id:item.id,mode:'remove'}))}</div>
        {item.runtimeError && <p role="alert">{code('runtimeError')} {button('retry',()=>void run('/api/mods/'+item.id,jsonInit('PATCH',{enabled:false}),selection))}</p>}
        {item.enabled&&item.id==='momo.qq'&&<OfficialPlugins/>}
        {item.enabled&&item.id==='momo.minecraft'&&<MinecraftCompanion/>}
        {item.kind==='content'&&item.resources.map(r=><p key={r.path}>{code(r.type)} · {r.path}</p>)}
      </>}
      {error&&<p role="alert">{code(error)}</p>}
      <div className="modal-foot">{button('close',()=>open(null))}</div>
      </div>
    </Modal>}
  </>;
}
