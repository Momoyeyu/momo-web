import {useEffect,useRef,useState} from 'react';
import {useT} from '../../i18n';
import {apiJson,jsonInit} from '../../services/http';
import {runtimeFetch} from '../../services/runtime';
import {refreshActivities} from '../../services/extensionActivities';
import {applyModChange,refreshMods,useMods,type InstalledMod} from '../../services/mods';
import {retiredSocialRecords, type RetiredSocialRecord} from '../../services/socialClient';
import Confirm from '../../ui/Confirm';
import Pager from '../../ui/Pager';
import {clampPage} from '../../lib/paging';
import FieldRow from '../../ui/FieldRow';
import Button from '../../ui/Button';
import IconButton from '../../ui/IconButton';
import DialogBackButton from '../../ui/DialogBackButton';
import Modal from '../../ui/Modal';
import Switch from '../../ui/Switch';
import OfficialPlugins from './OfficialPlugins';
import MinecraftCompanion from './MinecraftCompanion';
import RetiredSocialRecords from './RetiredSocialRecords';

type OfficialMod = {id:string; name:string; version:string; compatible:boolean};
type LibraryView = 'installed' | 'catalog';
type Selection = {id:string; mode:'manage'|'install'|'remove'} | {mode:'local'; file?:File};

export default function ModsPanel(){
  const t=useT(), mods=useMods(), file=useRef<HTMLInputElement>(null);
  const [manager,setManager]=useState(false);
  const [history,setHistory]=useState(false);
  const [retired,setRetired]=useState<RetiredSocialRecord[]>([]);
  useEffect(() => {
    if (!manager) return;
    const controller = new AbortController();
    void retiredSocialRecords(controller.signal).then(records => {
      if (!controller.signal.aborted) setRetired(records);
    }).catch(() => {});
    return () => controller.abort();
  }, [manager]);
  const [view,setView]=useState<LibraryView>('installed');
  const [catalog,setCatalog]=useState<OfficialMod[]|null>(null);
  const [catalogFailed,setCatalogFailed]=useState(false);
  const [catalogRetry,setCatalogRetry]=useState(0);
  const [selection,select]=useState<Selection|null>(null);
  const [page,setPage]=useState(0);
  const [query,setQuery]=useState('');
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const working=useRef(false), code=(key:string)=>t('modManager.'+key);
  const item=selection && 'id' in selection ? mods.find(m=>m.id===selection.id) : undefined;
  const load=()=>refreshMods().catch(()=>setError('listError'));
  useEffect(()=>{
    if(!manager||view!=='catalog')return;
    const controller=new AbortController();
    setCatalogFailed(false);
    void apiJson<{mods:OfficialMod[]}>('/api/mods/official',{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted)setCatalog(result.mods);
    }).catch(()=>{if(!controller.signal.aborted)setCatalogFailed(true);});
    return ()=>controller.abort();
  },[manager,view,catalogRetry]);
  function showView(next:LibraryView) {
    setError('');
    setView(next);
    setPage(0);
    setQuery('');
  }
  function closeLibrary(){if(!working.current)setManager(false);}
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
        if(init.method==='POST')showView('installed');
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
  function setEnabled(mod: InstalledMod, enabled: boolean) {
    void run('/api/mods/'+mod.id, jsonInit('PATCH', {enabled}), selection);
  }
  const candidate=selection && 'id' in selection ? catalog?.find(mod=>mod.id===selection.id) : undefined;
  const name=item?.name??candidate?.name??'';
  const entries=view==='installed' ? mods : catalog?.filter(mod=>!mods.some(owned=>owned.id===mod.id))??[];
  const filterable=entries.length>5;
  const matches=filterable ? entries.filter(mod=>(mod.id+' '+mod.name).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : entries;
  const paging=clampPage(page,matches.length,5);
  return <>
    <FieldRow label={code('library')}><IconButton icon="gear" label={code('manageLibrary')} tip={code('manageLibrary')} disabled={busy} onClick={()=>{
      showView('installed');
      setManager(true);
      void load();
    }}/></FieldRow>
    {manager&&<Modal label={code('library')} onClose={closeLibrary} className="extension-modal mod-library">
      <header className="extension-detail-header settings-dialog-heading mod-dialog-heading">
        <DialogBackButton onClick={closeLibrary} disabled={busy}/>
        <h3>{code('library')}</h3>
      </header>
      <div className="mod-library-header">
        <div className="settings-view-tabs mod-library-views" role="group" aria-label={code('library')}>
          {(['installed','catalog'] as const).map(section=><Button key={section}
            aria-pressed={view===section} disabled={busy} onClick={()=>showView(section)}>{code(section)}</Button>)}
        </div>
        {view==='catalog'&&button('import',()=>open({mode:'local'}))}
      </div>
      {filterable&&<input type="search" className="list-search" value={query} aria-label={code('search')} placeholder={code('search')} onChange={e=>{setQuery(e.target.value);setPage(0);}}/>}
      {view==='catalog' && catalogFailed ? <p role="alert">{code('catalogError')} {button('retry',()=>setCatalogRetry(n=>n+1))}</p>
      : view==='catalog' && catalog===null ? <p role="status">{t('config.loading')}</p>
      : !matches.length && <p className="muted">{code(entries.length?'noMatches':view==='installed'?'empty':'catalogEmpty')}</p>}
      <div className="mod-library-rows">
        {!!retired.length && <FieldRow label={t('social.retiredLibrary')}>
          <span className="config-value">{t('social.retiredCount',{count: String(retired.length)})}</span>
          <IconButton icon="backlog" label={t('social.retiredLibrary')} tip={t('social.retiredLibrary')}
            disabled={busy} onClick={() => setHistory(true)}/>
        </FieldRow>}
        {matches.slice(paging.page*5,paging.page*5+5).map(mod=><FieldRow key={mod.id} label={mod.name}>
          {'enabled' in mod ? <div className="mod-row-actions">
            <Switch title={mod.name} on={mod.enabled} disabled={busy} onChange={enabled=>setEnabled(mod,enabled)}/>
            <IconButton icon="gear" label={t('modManager.configureName',{name:mod.name})}
              tip={code('configure')} disabled={busy} onClick={()=>open({id:mod.id,mode:'manage'})}/>
            <IconButton icon="trash" label={t('modManager.removeName',{name:mod.name})}
              tip={code('removeIcon')} danger disabled={busy} onClick={()=>open({id:mod.id,mode:'remove'})}/>
          </div> : <>
            {!mod.compatible&&<span className="config-value">{code('platformUnavailable')}</span>}
            {button('install',()=>open({id:mod.id,mode:'install'}),!mod.compatible)}
          </>}
        </FieldRow>)}
      </div>
      {filterable&&<Pager page={paging.page} pages={paging.pages} onChange={setPage}/>}
      {!selection&&error&&<p role="alert">{code(error)} {button('retry',()=>{setError('');void load();})}</p>}
    </Modal>}
    {history && <RetiredSocialRecords records={retired} onClose={() => setHistory(false)} onChanged={records => {
      setRetired(records);
      if (!records.length) setHistory(false);
    }}/>}
    {selection?.mode === 'remove' && <Confirm title={code('remove')} subject={name}
      message={code('removeHint')} error={error ? code(error) : undefined} danger busy={busy}
      confirmLabel={code('remove')} onCancel={() => open(null)}
      onConfirm={() => void run('/api/mods/' + selection.id, {method:'DELETE'}, null)}/>}
    {selection&&selection.mode!=='remove'&&<Modal label={selection.mode==='local'?code('import'):name} onClose={()=>open(null)} className="extension-modal">
      <div className="extension-detail">
      <header className="settings-dialog-heading mod-dialog-heading">
        <DialogBackButton onClick={()=>open(null)} disabled={busy}/>
        <h3>{selection.mode==='local'?code('import'):name}</h3>
      </header>
      {selection.mode==='local' ? <>
        <p>{code('importHint')}</p>
        <input ref={file} type="file" hidden accept=".momomod" onChange={e=>{
          const picked=e.target.files?.[0];e.target.value='';
          if(picked)open({mode:'local',file:picked});
        }}/>
        {selection.file ? <><p>{selection.file.name}</p>{button('import',()=>{
          if(!selection.file)return;
          const data=new FormData();data.append('file',selection.file);
          void run('/api/mods',{method:'POST',body:data},null);
        })}</> : button('import',()=>file.current?.click())}
      </>
      : selection.mode==='install' ? <><p>{code('officialHint')}</p>
        {button('install',()=>void run('/api/mods/official/'+selection.id,{method:'POST'},{id:selection.id,mode:'manage'}))}</>
      : item && <><p>{item.version} · {code(item.enabled?'enabled':'disabled')}</p>
        <p>{code(item.source==='official'?'officialSource':'localSource')} · {(item.platforms??[]).map(platform=>platform==='*'?code('allPlatforms'):platform).join(', ')}</p>
        <div className="extension-detail-actions">{button(item.enabled?'disable':'enable',()=>setEnabled(item,!item.enabled))}</div>
        {item.runtimeError && <p role="alert">{code('runtimeError')} {button('retry',()=>void run('/api/mods/'+item.id,jsonInit('PATCH',{enabled:false}),selection))}</p>}
        {item.enabled&&item.id==='momo.qq'&&<OfficialPlugins/>}
        {item.enabled&&item.id==='momo.minecraft'&&<MinecraftCompanion packageVersion={item.version}/>}
        {item.kind==='content'&&item.resources.map(r=><p key={r.path}>{code(r.type)} · {r.path}</p>)}
      </>}
      {error&&<p role="alert">{code(error)}</p>}
      </div>
    </Modal>}
  </>;
}
