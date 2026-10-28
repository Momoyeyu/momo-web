import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import {useT} from '../../i18n';
import {connectSocialAccount,retiredSocialRecords,socialAccounts,SOCIAL_PROVIDERS,type RetiredSocialRecord,type SocialAccount,type SocialProvider} from '../../services/socialClient';
import RetiredSocialRecords from './RetiredSocialRecords';
import {observeQQRuntime,type QQLoginErrorCode,type QQRuntimeAction,type QQRuntimeState} from '../../services/qqRuntimeClient';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
import Icon from '../../ui/Icon';
import '../../styles/social.css';

const SocialConfigModal=lazy(()=>import('./SocialConfigModal'));
export default function OfficialPlugins({active=true}:{active?:boolean}){
  const t=useT();const [accounts,setAccounts]=useState<SocialAccount[]>([]);
  const [retired,setRetired]=useState<RetiredSocialRecord[]>([]);
  const [editing,setEditing]=useState<SocialProvider|null>(null);
  const [error,setError]=useState(false);const [actionError,setActionError]=useState(false);const [pending,setPending]=useState(false);
  const [runtime,setRuntime]=useState<QQRuntimeState|null>(null);
  const [runtimeError,setRuntimeError]=useState<QQLoginErrorCode|null>(null);
  const [runtimeBusy,setRuntimeBusy]=useState(false);
  const [pendingAction,setPendingAction]=useState<QQRuntimeAction|null>(null);
  const observer=useRef<ReturnType<typeof observeQQRuntime>|null>(null);
  const alive=useRef(true);const accountRead=useRef(0);const readingAccounts=useRef(0);const actionLock=useRef(false);
  const refresh=useCallback(async()=>{
    const own=++accountRead.current;readingAccounts.current++;
    try{const result=await socialAccounts();if(alive.current&&own===accountRead.current)setAccounts(result.accounts);}
    finally{readingAccounts.current--;}
  },[]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;accountRead.current++;};},[]);
  useEffect(()=>{
    if(!active)return;const request=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const poll=async()=>{
      try{
        if(document.visibilityState==='hidden'||actionLock.current||readingAccounts.current>0)return;
        await Promise.all([refresh(),retiredSocialRecords(request.signal).then(records=>{if(!request.signal.aborted)setRetired(records);})]);
        if(!request.signal.aborted)setError(false);
      }catch{if(!request.signal.aborted)setError(true);}
      finally{if(!request.signal.aborted)timer=setTimeout(()=>void poll(),2500);}
    };
    void poll();return()=>{request.abort();clearTimeout(timer);accountRead.current++;};
  },[active,refresh]);
  useEffect(()=>{
    if(!active)return;
    let identity:string|null=null;
    // The card and dialog share one sequential observer. Closing or switching
    // the view never owns, cancels or logs out the native account session.
    const observation=observeQQRuntime({onState:state=>{
      setRuntime(state);
      if(state?.connected&&identity!==state.actualSelfId){identity=state.actualSelfId;void refresh().catch(()=>setError(true));}
      else if(state&&!state.connected)identity=null;
    },onError:setRuntimeError,onBusy:setRuntimeBusy});
    observer.current=observation;observation.start();
    return()=>{observer.current=null;observation.dispose();setRuntimeBusy(false);};
  },[active,refresh]);
  const updateAccount=(next:SocialAccount)=>{
    if(alive.current){accountRead.current++;setAccounts(current=>current.map(account=>account.provider===next.provider?next:account));}
  };
  const updatePreferences=(next:SocialAccount)=>{
    if(alive.current)setAccounts(current=>current.map(account=>account.provider===next.provider&&next.policyRevision>=account.policyRevision?{...account,permissions:next.permissions,allowlistEnabled:next.allowlistEnabled,allowlist:next.allowlist,policyRevision:next.policyRevision}:account));
  };
  const run=async(action:'begin'|'forget')=>{
    if(actionLock.current||!observer.current||!runtime||(action==='begin'?runtime.connected:!runtime.connected))return;
    actionLock.current=true;setPendingAction(action);setPending(true);setError(false);setActionError(false);
    try{await observer.current.act(action);}
    finally{
      // Forget may disable business even when credential removal fails. Read
      // actual account state; an earlier persistence failure must not look OFF.
      try{await refresh();}catch{if(alive.current)setError(true);}
      actionLock.current=false;if(alive.current){setPending(false);setPendingAction(null);}
    }
  };
  const toggle=async(account:SocialAccount,enabled:boolean)=>{
    if(actionLock.current||(enabled&&!runtime?.connected))return;
    actionLock.current=true;setPending(true);setError(false);setActionError(false);
    try{updateAccount(await connectSocialAccount(account.provider,enabled));}
    catch{if(alive.current)setActionError(true);try{await refresh();}catch{/* Keep the operation error visible. */}}
    finally{actionLock.current=false;if(alive.current)setPending(false);}
  };
  const busy=pending||runtimeBusy;
  return <section className="official-plugins" aria-label={t('social.official')}>
    <div className="panel-title-row"><h3 className="opt-group">{t('social.official')}</h3><Hint text={t('social.officialHint')} side="down" /></div>
    {error||actionError?<div className="social-load-error" role="alert"><span>{t(actionError?'social.actionError':'social.loadError')}</span></div>:null}
    <div className="social-cards">{SOCIAL_PROVIDERS.map(provider=>{
      const account=accounts.find(item=>item.provider===provider);
      return <article className={`social-card social-${provider}`} key={provider}>
        <div className="social-card-top"><span className="social-app-mark" aria-hidden="true"><Icon name="phone" size={24}/></span><h4>{t(`social.providers.${provider}`)}</h4><Switch title={t('social.enableProvider',{provider:t(`social.providers.${provider}`)})} on={account?.enabled??false} disabled={!account||busy||(!account.enabled&&!runtime?.connected)} onChange={enabled=>{if(account)void toggle(account,enabled);}} /></div>
        <p className="social-account-identity">{runtime?.actualSelfId||account?.actualSelfId||account?.expectedSelfId||t('social.noAccount')}</p>
        <div className="social-card-bottom"><span className={`social-state${account?.status==='connected'?' is-connected':''}`}><i/>{t(`social.status.${account?.status??'loading'}`)===`social.status.${account?.status??'loading'}`?t('social.status.disconnected'):t(`social.status.${account?.status??'loading'}`)}</span><Button size="sm" variant="ghost" disabled={!account} onClick={()=>setEditing(provider)}>{t('social.configure')}</Button></div>
      </article>;
    })}</div>
    {retired.length>0 && <RetiredSocialRecords records={retired} onChanged={setRetired}/>}
    {active&&editing&&accounts.find(item=>item.provider===editing)?<Suspense fallback={<div role="status" className="social-loading">{t('social.loading')}</div>}><SocialConfigModal account={accounts.find(item=>item.provider===editing)!} runtime={runtime} runtimeError={runtimeError} busy={busy} pendingAction={pendingAction} onLogin={()=>void run('begin')} onLogout={()=>void run('forget')} onClose={()=>setEditing(null)} onAccountChanged={updatePreferences}/></Suspense>:null}
  </section>;
}
