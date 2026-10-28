import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {useT} from '../../i18n';
import {DEFAULT_PROACTIVE_POLICY,socialPreferenceWriter,socialRecords,type SocialAccount,type SocialPermission,type SocialRecord} from '../../services/socialClient';
import type {SocialPreferencePatch} from '../../services/socialPreferences';
import type {QQLoginErrorCode,QQRuntimeAction,QQRuntimeState} from '../../services/qqRuntimeClient';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import FieldRow from '../../ui/FieldRow';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
import Select from '../../ui/Select';
import QQScopeEditor from './QQScopeEditor';
import QQMediaLibrary from './QQMediaLibrary';
import QQLoginPanel from './QQLoginPanel';

const TABS=['account','permissions','records'] as const;
const PERMISSION_GROUPS:{id:string;permissions:SocialPermission[]}[]=[{id:'messages',permissions:['receive','reply','media']},{id:'account',permissions:['proactive','contacts','history','friendRequests']},{id:'groups',permissions:['groups','groupManagement']}];
const HOURS=Array.from({length:24},(_,i)=>({value:String(i),label:`${String(i).padStart(2,'0')}:00`}));
const RECORD_ACTIONS=new Map([
  ['contacts.list','contacts'],['history.list','history'],['private.send','privateSend'],
  ['group.send','groupSend'],['media.send','mediaSend'],['media.fetch','mediaFetch'],
  ['friends.listRequests','friendRequests'],['friends.respond','friendRespond'],
  ['groups.list','groups'],['groups.members','groupMembers'],['groups.manage','groupManage'],
  ['automatic.reply','reply'],
]);
const preferences=(account:SocialAccount)=>({permissions:{...account.permissions},allowlistEnabled:account.allowlistEnabled,allowlist:account.allowlist.map(peer=>({...peer})),groupAllowlist:(account.groupAllowlist??[]).map(peer=>({...peer})),proactivePolicy:{...DEFAULT_PROACTIVE_POLICY,...account.proactivePolicy}});
export default function SocialConfigModal({account,runtime,runtimeError,busy,pendingAction,onLogin,onLogout,onClose,onAccountChanged}:{
  account:SocialAccount;runtime:QQRuntimeState|null;runtimeError:QQLoginErrorCode|null;busy:boolean;pendingAction:QQRuntimeAction|null;
  onLogin:()=>void;onLogout:()=>void;onClose:()=>void;onAccountChanged:(account:SocialAccount)=>void;
}){
  const t=useT();const provider=account.provider;
  const [draft,setDraft]=useState(()=>preferences(account));
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
      const next={...preferences(actual),...pending,permissions:{...actual.permissions,...pending.permissions},proactivePolicy:{...DEFAULT_PROACTIVE_POLICY,...actual.proactivePolicy,...pending.proactivePolicy}};
      setDraft(next);setSaved(true);
    },
    onError:failed=>{if(alive.current){setSaveError(failed);if(failed){setDraft(preferences(confirmed.current));}}},
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
    setSaved(false);setSaveError(false);setDraft(current=>({...current,...value,permissions:{...current.permissions,...value.permissions},proactivePolicy:{...current.proactivePolicy,...value.proactivePolicy}}));writer.patch(value);
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
        {account.error?<p className="social-error">{account.error}</p>:null}
        {account.ownerPeerId?<p className="social-help">{t('social.ownerVerified',{id:account.ownerPeerId})}</p>:null}
        {account.status==='quarantined'?<p className="social-help">{t('social.unknownHold')}</p>:null}
      </section>
      <section id="social-panel-permissions" role="tabpanel" aria-labelledby="social-tab-permissions" aria-hidden={tab!=='permissions'} inert={tab!=='permissions'} className="social-pane">
        <div className="social-permission-heading"><h3>{t('social.messagePermissions')}</h3><Hint text={t('social.permissionsHint')} side="down"/></div>
        <div className="social-permission-groups">{PERMISSION_GROUPS.map(group=><section className="social-permission-group" key={group.id} aria-label={t(`social.permissionGroups.${group.id}`)}><h4>{t(`social.permissionGroups.${group.id}`)}</h4><div className="social-permission-grid">{group.permissions.map(permission=><FieldRow key={permission} label={t(`social.permissions.${permission}`)} hint={t(`social.permissionHints.${permission}`)}><Switch title={t(`social.permissions.${permission}`)} on={draft.permissions[permission]===true} onChange={value=>patch({permissions:{[permission]:value}})}/></FieldRow>)}</div></section>)}</div>
        <div className="social-allowlist"><FieldRow label={t('social.allowlist')} hint={`${t('social.allowlistHint')}${draft.allowlistEnabled&&draft.allowlist.length===0?` ${t('social.allowlistEmpty')}`:''}`}><Switch title={t('social.allowlist')} on={draft.allowlistEnabled} onChange={allowlistEnabled=>patch({allowlistEnabled})}/></FieldRow>
          {draft.allowlistEnabled?<div className="social-scope-inset"><QQScopeEditor id="social-peer-input" label={t('social.allowlistIds')} hint={t('social.contactHint')} emptyHint={t('social.allowlistEmpty')} placeholder={t('social.contactPlaceholder')} listLabel={t('social.contactList')} removeLabel={t('social.removeContact')} value={draft.allowlist} onChange={allowlist=>patch({allowlist})}/></div>:null}
        </div>
        {draft.permissions.media&&account.permissions.media?<QQMediaLibrary/>:null}
        {draft.permissions.proactive?<section className="social-policy-section social-proactive-policy" aria-label={t('social.proactiveSettings')}>
          <div className="social-permission-heading"><h3>{t('social.proactiveSettings')}</h3><Hint text={t('social.proactiveSettingsHint')} side="down"/></div>
          <QQScopeEditor id="social-proactive-input" label={t('social.proactiveRecipients')} hint={t('social.contactHint')} emptyHint={t('social.proactiveEmpty')} placeholder={t('social.contactPlaceholder')} listLabel={t('social.proactiveRecipientList')} removeLabel={t('social.removeProactiveRecipient')} value={draft.proactivePolicy.recipientIds.map(peerId=>({peerId}))} onChange={peers=>patch({proactivePolicy:{recipientIds:peers.map(peer=>peer.peerId)}})}/>
          <div className="social-policy-grid">
            <FieldRow label={t('social.proactiveMaxPerHour')} hint={t('social.proactiveMaxPerHourHint')}><Select value={String(draft.proactivePolicy.maxPerHour)} options={[...new Set([1,3,6,12,30,60,draft.proactivePolicy.maxPerHour])].sort((a,b)=>a-b).map(value=>({value:String(value),label:t('social.perHour',{value:String(value)})}))} onChange={value=>patch({proactivePolicy:{maxPerHour:Number(value)}})}/></FieldRow>
            <FieldRow label={t('social.proactiveInterval')} hint={t('social.proactiveIntervalHint')}><Select value={String(draft.proactivePolicy.minIntervalSeconds)} options={[...new Set([0,30,60,300,900,3600,draft.proactivePolicy.minIntervalSeconds])].sort((a,b)=>a-b).map(value=>({value:String(value),label:t('social.seconds',{value:String(value)})}))} onChange={value=>patch({proactivePolicy:{minIntervalSeconds:Number(value)}})}/></FieldRow>
            <FieldRow label={t('social.proactiveQuietStart')} hint={t('social.proactiveQuietHint')}><Select value={String(draft.proactivePolicy.quietStart)} options={HOURS} onChange={value=>patch({proactivePolicy:{quietStart:Number(value)}})}/></FieldRow>
            <FieldRow label={t('social.proactiveQuietEnd')} hint={t('social.proactiveQuietHint')}><Select value={String(draft.proactivePolicy.quietEnd)} options={HOURS} onChange={value=>patch({proactivePolicy:{quietEnd:Number(value)}})}/></FieldRow>
          </div>
        </section>:null}
        {draft.permissions.groups||draft.permissions.groupManagement?<section className="social-policy-section social-group-policy" aria-label={t('social.groupSettings')}><div className="social-permission-heading"><h3>{t('social.groupSettings')}</h3><Hint text={t('social.groupSettingsHint')} side="down"/></div><QQScopeEditor id="social-group-input" label={t('social.groupIds')} hint={t('social.groupInputHint')} emptyHint={t('social.groupsEmpty')} placeholder={t('social.groupPlaceholder')} listLabel={t('social.groupList')} removeLabel={t('social.removeGroup')} value={draft.groupAllowlist} onChange={groupAllowlist=>patch({groupAllowlist})}/></section>:null}
      </section>
      <section id="social-panel-records" role="tabpanel" aria-labelledby="social-tab-records" aria-hidden={tab!=='records'} inert={tab!=='records'} className="social-pane">
        <div className="social-record-heading"><h3>{t('social.operationRecords')}</h3></div>
        {recordError?<p role="alert" className="social-error">{t('social.recordsError')}</p>:null}
        {loadingRecords?<p className="muted">{t('social.loading')}</p>:records.length===0?<p className="social-empty-records">{t('social.noRecords')}</p>:records.map(record=><article className="social-record" key={record.commandId}>
          <div className="social-record-top"><strong>{RECORD_ACTIONS.has(record.action??'')?`${t(`social.recordActions.${RECORD_ACTIONS.get(record.action!)}`)}${record.peerId?` · ${record.peerId}`:''}`:record.peerId||t('social.unknownPeer')}</strong><span>{t(`social.delivery.${record.status}`)===`social.delivery.${record.status}`?t('social.delivery.unknown'):t(`social.delivery.${record.status}`)}</span></div>
          <code>{record.commandId}</code>{record.createdAt?<time>{record.createdAt}</time>:null}{record.evidence?<pre className="social-record-evidence">{typeof record.evidence==='string'?record.evidence:JSON.stringify(record.evidence,null,2)}</pre>:null}{record.error?<p className="social-error">{record.error}</p>:null}
          {record.status==='unknown'?<p className="social-help">{t('social.unknownHold')}</p>:null}
        </article>)}
      </section>
    </div></div>
    <footer className="social-modal-footer"><span className={`social-save-state${saveError?' is-error':''}`} role="status">{t(saveError?'social.saveError':saving?'social.saving':saved?'social.saved':'social.autoSave')}</span><Button variant="ghost" onClick={close}>{t('common.close')}</Button></footer>
  </Modal>;
}
