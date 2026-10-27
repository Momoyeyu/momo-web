import {lazy,Suspense,useEffect,useState} from 'react';
import {useT} from '../../i18n';
import {accountDraft,connectSocialAccount,retiredSocialRecords,saveSocialAccount,socialAccounts,SOCIAL_PROVIDERS,type RetiredSocialRecord,type SocialAccount,type SocialProvider} from '../../services/socialClient';
import RetiredSocialRecords from './RetiredSocialRecords';
import {qqRuntimeStatus} from '../../services/qqRuntimeClient';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
import Icon from '../../ui/Icon';
import '../../styles/social.css';

const SocialConfigModal=lazy(()=>import('./SocialConfigModal'));
export default function OfficialPlugins({active=true}:{active?:boolean}){
  const t=useT();
  const [accounts,setAccounts]=useState<SocialAccount[]>([]);
  const [retired,setRetired]=useState<RetiredSocialRecord[]>([]);
  const [editing,setEditing]=useState<SocialProvider|null>(null);
  const [error,setError]=useState(false);
  const [pending,setPending]=useState<SocialProvider|null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!active)return;
    const request=new AbortController();setError(false);
    void Promise.all([
      socialAccounts(request.signal).then(result=>{if(!request.signal.aborted)setAccounts(result.accounts);}),
      retiredSocialRecords(request.signal).then(records=>{if(!request.signal.aborted)setRetired(records);}),
    ]).catch(()=>{if(!request.signal.aborted)setError(true);});
    return()=>request.abort();
  },[active,revision]);
  const refresh=()=>setRevision(value=>value+1);
  const toggle=async(account:SocialAccount,enabled:boolean)=>{
    setPending(account.provider);setError(false);
    try{
      if(enabled&&account.transport==='managed'){
        const native=await qqRuntimeStatus().catch(()=>null);
        if(!native?.connected||(account.expectedSelfId&&native.actualSelfId!==account.expectedSelfId)){setEditing(account.provider);return;}
        await connectSocialAccount(account.provider,true,'managed');
      }else{
        const draft=accountDraft(account);draft.enabled=enabled;
        await saveSocialAccount(account.provider,draft);
      }
      refresh();
    }catch{setError(true);}finally{setPending(null);}
  };
  return <section className="official-plugins" aria-label={t('social.official')}>
    <div className="panel-title-row"><h3 className="opt-group">{t('social.official')}</h3><Hint text={t('social.officialHint')} side="down" /></div>
    {error && <div className="social-load-error" role="alert"><span>{t('social.loadError')}</span><Button size="sm" variant="ghost" onClick={refresh}>{t('meeting.retry')}</Button></div>}
    <div className="social-cards">{SOCIAL_PROVIDERS.map(provider=>{
      const account=accounts.find(item=>item.provider===provider);
      return <article className={`social-card social-${provider}`} key={provider}>
        <div className="social-card-top"><span className="social-app-mark" aria-hidden="true"><Icon name="phone" size={24}/></span><h4>{t(`social.providers.${provider}`)}</h4><Switch title={t('social.enableProvider',{provider:t(`social.providers.${provider}`)})} on={account?.enabled??false} disabled={!account||pending===provider} onChange={enabled=>{if(account)void toggle(account,enabled);}} /></div>
        <p className="social-account-identity">{account?.actualSelfId||account?.expectedSelfId||t('social.noAccount')}</p>
        <div className="social-card-bottom"><span className={`social-state${account?.status==='connected'?' is-connected':''}`}><i/>{t(`social.status.${account?.status??'loading'}`)===`social.status.${account?.status??'loading'}`?t('social.status.disconnected'):t(`social.status.${account?.status??'loading'}`)}</span><Button size="sm" variant="ghost" disabled={!account} onClick={()=>setEditing(provider)}>{t('social.configure')}</Button></div>
      </article>;
    })}</div>
    {retired.length>0 && <RetiredSocialRecords records={retired} onChanged={setRetired}/>}
    {active && editing && accounts.find(item=>item.provider===editing) && <Suspense fallback={<div role="status" className="social-loading">{t('social.loading')}</div>}><SocialConfigModal initial={accounts.find(item=>item.provider===editing)!} onClose={()=>setEditing(null)} onChanged={refresh}/></Suspense>}
  </section>;
}
