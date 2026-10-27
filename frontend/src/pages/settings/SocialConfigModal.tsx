import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {useT} from '../../i18n';
import {accountDraft,connectSocialAccount,ownerChallenge,parseAllowlist,reconcileSocialRecord,resumeSocialAccount,saveSocialAccount,socialAccounts,socialRecords,type SocialAccount,type SocialPermission,type SocialRecord} from '../../services/socialClient';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import FieldRow from '../../ui/FieldRow';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
import QQLoginPanel from './QQLoginPanel';
import {qqRuntimeStatus} from '../../services/qqRuntimeClient';

const TABS=['account','permissions','records'] as const;
const PERMISSIONS:SocialPermission[]=['receive','reply','proactive','contacts','history'];
const UNSUPPORTED=['media','friendRequests','groups','profile'] as const;
export default function SocialConfigModal({initial,onClose,onChanged}:{initial:SocialAccount;onClose:()=>void;onChanged:()=>void}){
  const t=useT();const provider=initial.provider;
  const [account,setAccount]=useState(initial);
  const [draft,setDraft]=useState(()=>accountDraft(initial));
  const [allowlist,setAllowlist]=useState(initial.allowlist.map(peer=>peer.peerId).join('\n'));
  const [tab,setTab]=useState<(typeof TABS)[number]>('account');
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [records,setRecords]=useState<SocialRecord[]>([]);const [loadingRecords,setLoadingRecords]=useState(false);
  const [recordRevision,setRecordRevision]=useState(0);
  const [confirm,setConfirm]=useState<{commandId:string;outcome:'completed'|'failed'|'closed_unknown'}|null>(null);
  const [peerId,setPeerId]=useState('');const [challenge,setChallenge]=useState('');
  const buttons=useRef<(HTMLButtonElement|null)[]>([]);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(tab!=='records')return;
    const request=new AbortController();setLoadingRecords(true);
    void socialRecords(provider,request.signal).then(setRecords).catch(()=>{if(!request.signal.aborted)setError(t('social.recordsError'));}).finally(()=>{if(!request.signal.aborted)setLoadingRecords(false);});
    return()=>request.abort();
  },[tab,provider,recordRevision]);
  const refreshAccount=async(syncEnabled=false)=>{
    const result=await socialAccounts();const next=result.accounts.find(item=>item.provider===provider);
    if(next&&alive.current){setAccount(next);if(syncEnabled)setDraft(current=>({...current,enabled:next.enabled}));}onChanged();
  };
  const perform=async(operation:()=>Promise<unknown>,close=false)=>{
    if(busy)return;setBusy(true);setError(null);
    try{await operation();if(alive.current){await refreshAccount();if(close)onClose();}}
    catch(error){if(alive.current)setError(t(error instanceof Error&&error.message==='QQ_LOGIN_REQUIRED'?'social.login.loginFirst':'social.actionError'));}finally{if(alive.current)setBusy(false);}
  };
  const save=()=>{
    const reconnect=draft.enabled&&!account.enabled;
    if(!reconnect){void perform(()=>saveSocialAccount(provider,{...draft,allowlist:parseAllowlist(allowlist)}),true);return;}
    void perform(async()=>{
      const native=await qqRuntimeStatus();
      if(!native.connected){setTab('account');throw new Error('QQ_LOGIN_REQUIRED');}
      await saveSocialAccount(provider,{...draft,enabled:undefined,allowlist:parseAllowlist(allowlist)});
      await connectSocialAccount(provider,true);
    },true);
  };
  const navigateTab=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    let next=index;
    if(event.key==='ArrowRight')next=(index+1)%TABS.length;
    else if(event.key==='ArrowLeft')next=(index+TABS.length-1)%TABS.length;
    else if(event.key==='Home')next=0;else if(event.key==='End')next=TABS.length-1;else return;
    event.preventDefault();setTab(TABS[next]!);buttons.current[next]?.focus();
  };
  const patchPermission=(permission:SocialPermission,value:boolean)=>setDraft(current=>({...current,permissions:{...current.permissions,[permission]:value}}));
  const index=TABS.indexOf(tab);
  return <Modal className="social-modal" label={t('social.modalTitle',{provider:t(`social.providers.${provider}`)})} onClose={()=>{if(!busy)onClose();}}>
    <header className="social-modal-heading"><h2>{t(`social.providers.${provider}`)}</h2><span className="muted">{t('social.accountSettings')}</span></header>
    <nav className="social-tabs" role="tablist" aria-label={t('social.accountSettings')}><span className="social-tab-thumb" style={{transform:`translateX(${index*100}%)`}}/>{TABS.map((id,i)=><button type="button" ref={element=>{buttons.current[i]=element;}} id={`social-tab-${id}`} key={id} role="tab" aria-selected={tab===id} aria-controls={`social-panel-${id}`} tabIndex={tab===id?0:-1} className={tab===id?'active':''} onKeyDown={event=>navigateTab(event,i)} onClick={()=>setTab(id)}>{t(`social.tabs.${id}`)}</button>)}</nav>
    {error && <p role="alert" className="social-error">{error}</p>}
    <div className="social-viewport"><div className="social-track" style={{transform:`translateX(${-index*100}%)`}}>
      <section id="social-panel-account" role="tabpanel" aria-labelledby="social-tab-account" aria-hidden={tab!=='account'} inert={tab!=='account'} className="social-pane">
        <QQLoginPanel active={tab==='account'} identityDirty={draft.expectedSelfId!==account.expectedSelfId} channel={account} connectionBusy={busy} onAuthenticated={()=>{void refreshAccount().catch(()=>{});}} onSignOut={async operation=>{
          if(busy||!alive.current)return;setBusy(true);setError(null);
          try{await operation();}
          catch{if(alive.current)setError(t('social.actionError'));}
          finally{
            // Refresh on failure too: business may already be disabled while
            // native credentials remain. Preserve every other unsaved field.
            try{await refreshAccount(true);}
            catch{if(alive.current)setError(t('social.loadError'));}
            finally{if(alive.current)setBusy(false);}
          }
        }} onConnect={()=>void perform(async()=>{
          // The explicit action saves the visible grants; /connect alone enables
          // and binds the verified native account. Authentication never does.
          await saveSocialAccount(provider,{...draft,enabled:undefined,allowlist:parseAllowlist(allowlist)});
          const connected=await connectSocialAccount(provider,true);
          if(alive.current){setAccount(connected);setDraft(accountDraft(connected));setAllowlist(connected.allowlist.map(peer=>peer.peerId).join('\n'));}
        })}/>
        <div className="social-connection-state"><i className={account.status==='connected'?'is-connected':''}/><div><strong>{t(`social.status.${account.status}`)===`social.status.${account.status}`?t('social.status.disconnected'):t(`social.status.${account.status}`)}</strong><span>{account.actualSelfId?t('social.verifiedIdentity',{id:account.actualSelfId}):t('social.identityPending')}</span></div></div>
        {account.error && <p className="social-error">{account.error}</p>}
        {account.status==='quarantined' && <div className="social-connection-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void perform(()=>resumeSocialAccount(provider))}>{t('social.resume')}</Button></div>}
        <FieldRow label={t('social.enabled')}><Switch title={t('social.enabled')} on={draft.enabled} onChange={enabled=>setDraft(current=>({...current,enabled}))}/></FieldRow>
        <FieldRow label={t('social.expectedIdentity')} hint={t('social.identityHint')}><input value={draft.expectedSelfId} autoComplete="off" onChange={event=>setDraft(current=>({...current,expectedSelfId:event.target.value}))}/></FieldRow>
        <details className="social-disclosure"><summary>{t('social.ownerBinding')}<Hint text={t('social.ownerHint')} side="down"/></summary>
          {account.ownerPeerId?<p className="social-help">{t('social.ownerVerified',{id:account.ownerPeerId})}</p>:<><FieldRow label={t('social.peerId')}><input value={peerId} autoComplete="off" onChange={event=>setPeerId(event.target.value)}/></FieldRow><Button size="sm" variant="ghost" disabled={busy||!peerId.trim()||!account.capabilities.ownerBinding} onClick={()=>void perform(async()=>{const result=await ownerChallenge(provider,peerId.trim());if(alive.current)setChallenge(result.challenge);})}>{t('social.createChallenge')}</Button>{challenge && <div className="social-challenge"><p>{t('social.challengeInstructions')}</p><code>{challenge}</code><Button size="sm" variant="ghost" onClick={()=>void perform(refreshAccount)}>{t('social.checkBinding')}</Button></div>}</>}
        </details>
      </section>
      <section id="social-panel-permissions" role="tabpanel" aria-labelledby="social-tab-permissions" aria-hidden={tab!=='permissions'} inert={tab!=='permissions'} className="social-pane">
        <div className="social-permission-heading"><h3>{t('social.messagePermissions')}</h3><Hint text={t('social.permissionsHint')} side="down"/></div>
        {PERMISSIONS.map(permission=><FieldRow key={permission} label={t(`social.permissions.${permission}`)} hint={!account.capabilities[permission]?t('social.unsupported'):undefined}><Switch title={t(`social.permissions.${permission}`)} on={draft.permissions[permission]} disabled={!account.capabilities[permission]&&!draft.permissions[permission]} onChange={value=>patchPermission(permission,value)}/></FieldRow>)}
        <div className="social-allowlist"><FieldRow label={t('social.allowlist')} hint={t('social.allowlistHint')}><Switch title={t('social.allowlist')} on={draft.allowlistEnabled} onChange={allowlistEnabled=>setDraft(current=>({...current,allowlistEnabled}))}/></FieldRow>
          {draft.allowlistEnabled && <div className="social-allowlist-editor"><label htmlFor="social-peer-list">{t('social.allowlistIds')}</label><textarea id="social-peer-list" rows={4} value={allowlist} onChange={event=>setAllowlist(event.target.value)} spellCheck={false}/>{parseAllowlist(allowlist).length===0 && <p className="social-empty-policy">{t('social.allowlistEmpty')}</p>}</div>}
        </div>
        <div className="social-unsupported">{UNSUPPORTED.map(item=><div key={item}><span>{t(`social.permissions.${item}`)}</span><span>{t('social.unsupported')}</span></div>)}</div>
      </section>
      <section id="social-panel-records" role="tabpanel" aria-labelledby="social-tab-records" aria-hidden={tab!=='records'} inert={tab!=='records'} className="social-pane">
        <div className="social-record-heading"><h3>{t('social.operationRecords')}</h3><Button size="sm" variant="ghost" disabled={loadingRecords} onClick={()=>setRecordRevision(value=>value+1)}>{t('social.refresh')}</Button></div>
        {loadingRecords?<p className="muted">{t('social.loading')}</p>:records.length===0?<p className="social-empty-records">{t('social.noRecords')}</p>:records.map(record=><article className="social-record" key={record.commandId}>
          <div className="social-record-top"><strong>{record.peerId||t('social.unknownPeer')}</strong><span>{t(`social.delivery.${record.status}`)===`social.delivery.${record.status}`?t('social.delivery.unknown'):t(`social.delivery.${record.status}`)}</span></div>
          <code>{record.commandId}</code>{record.createdAt && <time>{record.createdAt}</time>}{record.evidence && <pre className="social-record-evidence">{typeof record.evidence==='string'?record.evidence:JSON.stringify(record.evidence,null,2)}</pre>}{record.error && <p className="social-error">{record.error}</p>}
          {record.status==='unknown' && <div className="social-recovery"><p className="muted">{t('social.recoveryHint')}</p>{confirm?.commandId===record.commandId?<div className="social-recovery-confirm"><p>{t(`social.confirm.${confirm.outcome}`)}</p><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirm(null)}>{t('common.cancel')}</Button><Button size="sm" disabled={busy} onClick={()=>void perform(async()=>{await reconcileSocialRecord(provider,confirm.commandId,confirm.outcome);setConfirm(null);setRecordRevision(value=>value+1);})}>{t('social.confirmAction')}</Button></div>:<div className="social-recovery-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirm({commandId:record.commandId,outcome:'completed'})}>{t('social.markSent')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setConfirm({commandId:record.commandId,outcome:'failed'})}>{t('social.markNotSent')}</Button><Button size="sm" variant="ghost" disabled={busy||record.executorQuiescent!==true} title={record.executorQuiescent===true?undefined:t('social.executorActive')} onClick={()=>setConfirm({commandId:record.commandId,outcome:'closed_unknown'})}>{t('social.closeUnknown')}</Button></div>}</div>}
        </article>)}
      </section>
    </div></div>
    <footer className="social-modal-footer"><Button variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button disabled={busy} onClick={save}>{t(busy?'social.saving':'common.save')}</Button></footer>
  </Modal>;
}
