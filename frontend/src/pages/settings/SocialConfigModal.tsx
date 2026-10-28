import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {useT} from '../../i18n';
import {parseAllowlist,socialPreferenceWriter,socialRecords,type SocialAccount,type SocialPermission,type SocialRecord} from '../../services/socialClient';
import type {SocialPreferencePatch} from '../../services/socialPreferences';
import type {QQLoginErrorCode,QQRuntimeAction,QQRuntimeState} from '../../services/qqRuntimeClient';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import FieldRow from '../../ui/FieldRow';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
import QQLoginPanel from './QQLoginPanel';

const TABS=['account','permissions','records'] as const;
const PERMISSIONS:SocialPermission[]=['receive','reply','proactive','contacts','history'];
const UNSUPPORTED=['media','friendRequests','groups','profile'] as const;
const preferences=(account:SocialAccount)=>({permissions:{...account.permissions},allowlistEnabled:account.allowlistEnabled,allowlist:account.allowlist.map(peer=>({...peer}))});
export default function SocialConfigModal({account,runtime,runtimeError,busy,pendingAction,onLogin,onLogout,onClose,onAccountChanged}:{
  account:SocialAccount;runtime:QQRuntimeState|null;runtimeError:QQLoginErrorCode|null;busy:boolean;pendingAction:QQRuntimeAction|null;
  onLogin:()=>void;onLogout:()=>void;onClose:()=>void;onAccountChanged:(account:SocialAccount)=>void;
}){
  const t=useT();const provider=account.provider;
  const [draft,setDraft]=useState(()=>preferences(account));
  const [allowlist,setAllowlist]=useState(account.allowlist.map(peer=>peer.peerId).join('\n'));
  const [tab,setTab]=useState<(typeof TABS)[number]>('account');
  const [saving,setSaving]=useState(false);const [saveError,setSaveError]=useState(false);const [saved,setSaved]=useState(false);
  const [records,setRecords]=useState<SocialRecord[]>([]);const [loadingRecords,setLoadingRecords]=useState(false);const [recordError,setRecordError]=useState(false);
  const buttons=useRef<(HTMLButtonElement|null)[]>([]);const alive=useRef(true);
  const confirmed=useRef(account);const accountChanged=useRef(onAccountChanged);accountChanged.current=onAccountChanged;
  const [writer]=useState(()=>socialPreferenceWriter(provider));
  useEffect(()=>{
    alive.current=true;
    const unsubscribe=writer.subscribe({
    onSettled:(actual,pending)=>{
      confirmed.current=actual;accountChanged.current(actual);
      if(!alive.current)return;
      const next={...preferences(actual),...pending,permissions:{...actual.permissions,...pending.permissions}};
      setDraft(next);if(pending.allowlist===undefined)setAllowlist(actual.allowlist.map(peer=>peer.peerId).join('\n'));setSaved(true);
    },
    onError:failed=>{if(alive.current){setSaveError(failed);if(failed){setDraft(preferences(confirmed.current));setAllowlist(confirmed.current.allowlist.map(peer=>peer.peerId).join('\n'));}}},
    onBusy:value=>{if(alive.current)setSaving(value);},
    });
    return()=>{alive.current=false;unsubscribe();void writer.flush();};
  },[writer]);
  useEffect(()=>{
    if(tab!=='records')return;
    const request=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    setLoadingRecords(true);setRecordError(false);
    const poll=async()=>{
      try{
        if(document.visibilityState==='hidden')return;
        const result=await socialRecords(provider,request.signal);
        if(!request.signal.aborted){setRecords(result);setRecordError(false);}
      }catch{if(!request.signal.aborted)setRecordError(true);}
      finally{if(!request.signal.aborted){setLoadingRecords(false);timer=setTimeout(()=>void poll(),2500);}}
    };
    void poll();return()=>{request.abort();clearTimeout(timer);};
  },[tab,provider]);
  const patch=(value:SocialPreferencePatch)=>{
    setSaved(false);setSaveError(false);setDraft(current=>({...current,...value,permissions:{...current.permissions,...value.permissions}}));writer.patch(value);
  };
  const close=()=>{void writer.flush();onClose();};
  const navigateTab=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    let next=index;
    if(event.key==='ArrowRight')next=(index+1)%TABS.length;
    else if(event.key==='ArrowLeft')next=(index+TABS.length-1)%TABS.length;
    else if(event.key==='Home')next=0;else if(event.key==='End')next=TABS.length-1;else return;
    event.preventDefault();setTab(TABS[next]!);buttons.current[next]?.focus();
  };
  const index=TABS.indexOf(tab);
  return <Modal className="social-modal" label={t('social.modalTitle',{provider:t(`social.providers.${provider}`)})} onClose={close}>
    <header className="social-modal-heading"><h2>{t(`social.providers.${provider}`)}</h2><span className="muted">{t('social.accountSettings')}</span></header>
    <nav className="social-tabs" role="tablist" aria-label={t('social.accountSettings')}><span className="social-tab-thumb" style={{transform:`translateX(${index*100}%)`}}/>{TABS.map((id,i)=><button type="button" ref={element=>{buttons.current[i]=element;}} id={`social-tab-${id}`} key={id} role="tab" aria-selected={tab===id} aria-controls={`social-panel-${id}`} tabIndex={tab===id?0:-1} className={tab===id?'active':''} onKeyDown={event=>navigateTab(event,i)} onClick={()=>setTab(id)}>{t(`social.tabs.${id}`)}</button>)}</nav>
    {saveError?<p role="alert" className="social-error">{t('social.saveError')}</p>:null}
    <div className="social-viewport"><div className="social-track" style={{transform:`translateX(${-index*100}%)`}}>
      <section id="social-panel-account" role="tabpanel" aria-labelledby="social-tab-account" aria-hidden={tab!=='account'} inert={tab!=='account'} className="social-pane">
        <QQLoginPanel runtime={runtime} error={runtimeError} busy={busy} pendingAction={pendingAction} onLogin={onLogin} onLogout={onLogout}/>
        <div className="social-connection-state"><i className={account.status==='connected'?'is-connected':''}/><div><strong>{t(`social.status.${account.status}`)===`social.status.${account.status}`?t('social.status.disconnected'):t(`social.status.${account.status}`)}</strong><span>{account.actualSelfId?t('social.verifiedIdentity',{id:account.actualSelfId}):t('social.identityPending')}</span></div></div>
        {account.error?<p className="social-error">{account.error}</p>:null}
        {account.ownerPeerId?<p className="social-help">{t('social.ownerVerified',{id:account.ownerPeerId})}</p>:null}
        {account.status==='quarantined'?<p className="social-help">{t('social.unknownHold')}</p>:null}
      </section>
      <section id="social-panel-permissions" role="tabpanel" aria-labelledby="social-tab-permissions" aria-hidden={tab!=='permissions'} inert={tab!=='permissions'} className="social-pane">
        <div className="social-permission-heading"><h3>{t('social.messagePermissions')}</h3><Hint text={t('social.permissionsHint')} side="down"/></div>
        {PERMISSIONS.map(permission=><FieldRow key={permission} label={t(`social.permissions.${permission}`)} hint={!account.capabilities[permission]?t('social.unsupported'):undefined}><Switch title={t(`social.permissions.${permission}`)} on={draft.permissions[permission]} disabled={!account.capabilities[permission]&&!draft.permissions[permission]} onChange={value=>patch({permissions:{[permission]:value}})}/></FieldRow>)}
        <div className="social-allowlist"><FieldRow label={t('social.allowlist')} hint={t('social.allowlistHint')}><Switch title={t('social.allowlist')} on={draft.allowlistEnabled} onChange={allowlistEnabled=>patch({allowlistEnabled})}/></FieldRow>
          {draft.allowlistEnabled?<div className="social-allowlist-editor"><label htmlFor="social-peer-list">{t('social.allowlistIds')}</label><textarea id="social-peer-list" rows={4} value={allowlist} onChange={event=>{setAllowlist(event.target.value);patch({allowlist:parseAllowlist(event.target.value)});}} spellCheck={false}/>{parseAllowlist(allowlist).length===0?<p className="social-empty-policy">{t('social.allowlistEmpty')}</p>:null}</div>:null}
        </div>
        <div className="social-unsupported">{UNSUPPORTED.map(item=><div key={item}><span>{t(`social.permissions.${item}`)}</span><span>{t('social.unsupported')}</span></div>)}</div>
      </section>
      <section id="social-panel-records" role="tabpanel" aria-labelledby="social-tab-records" aria-hidden={tab!=='records'} inert={tab!=='records'} className="social-pane">
        <div className="social-record-heading"><h3>{t('social.operationRecords')}</h3></div>
        {recordError?<p role="alert" className="social-error">{t('social.recordsError')}</p>:null}
        {loadingRecords?<p className="muted">{t('social.loading')}</p>:records.length===0?<p className="social-empty-records">{t('social.noRecords')}</p>:records.map(record=><article className="social-record" key={record.commandId}>
          <div className="social-record-top"><strong>{record.peerId||t('social.unknownPeer')}</strong><span>{t(`social.delivery.${record.status}`)===`social.delivery.${record.status}`?t('social.delivery.unknown'):t(`social.delivery.${record.status}`)}</span></div>
          <code>{record.commandId}</code>{record.createdAt?<time>{record.createdAt}</time>:null}{record.evidence?<pre className="social-record-evidence">{typeof record.evidence==='string'?record.evidence:JSON.stringify(record.evidence,null,2)}</pre>:null}{record.error?<p className="social-error">{record.error}</p>:null}
          {record.status==='unknown'?<p className="social-help">{t('social.unknownHold')}</p>:null}
        </article>)}
      </section>
    </div></div>
    <footer className="social-modal-footer"><span className={`social-save-state${saveError?' is-error':''}`} role="status">{t(saveError?'social.saveError':saving?'social.saving':saved?'social.saved':'social.autoSave')}</span><Button variant="ghost" onClick={close}>{t('common.close')}</Button></footer>
  </Modal>;
}
