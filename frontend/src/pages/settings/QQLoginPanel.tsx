import {useEffect,useState} from 'react';
import {useT} from '../../i18n';
import {visibleQQRuntime,type QQLoginErrorCode,type QQRuntimeAction,type QQRuntimeState} from '../../services/qqRuntimeClient';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';

export const QQ_LOGIN_PENDING=new Set<QQRuntimeState['status']>(['preparing','connecting','qr_pending','awaiting_confirmation','verifying']);
export default function QQLoginPanel({runtime,error,busy,pendingAction,onLogin,onLogout}:{
  runtime:QQRuntimeState|null;error:QQLoginErrorCode|null;busy:boolean;pendingAction:QQRuntimeAction|null;onLogin:()=>void;onLogout:()=>void;
}){
  const t=useT();const [now,setNow]=useState(Date.now);
  useEffect(()=>{if(!runtime?.qr)return;setNow(Date.now());const tick=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(tick);},[runtime?.qr?.expiresAt]);
  const state=runtime?visibleQQRuntime(runtime,now):null;
  const code=error??state?.error;
  const pending=state?QQ_LOGIN_PENDING.has(state.status):busy&&pendingAction==='begin';
  const message=code?t(`social.login.errors.${code}`):busy?t(pendingAction==='forget'?'social.login.forgetting':'social.login.states.preparing'):t(`social.login.states.${state?.status??'loading'}`);
  const qr=state?.qr;
  return <div className="qq-login" aria-label={t('social.login.title')}>
    <div className={`qq-login-visual${qr?' has-qr':''}${state?.connected?' is-connected':''}`}>
      {qr?<img src={qr.dataUrl} width={176} height={176} alt={t('social.login.qrAlt')} draggable={false}/>:<svg className="qq-login-symbol" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{state?.connected?<><circle cx="32" cy="32" r="23"/><path d="m21 32 7 7 15-16"/></>:<><path d="M23 12H12v11m29-11h11v11M12 41v11h11m29-11v11H41"/><rect x="23" y="18" width="18" height="28" rx="4"/><path d="M29 40h6"/></>}</svg>}
      {qr?<span className="qq-login-expiry">{t('social.login.expires',{seconds:String(Math.max(0,Math.ceil((qr.expiresAt-now)/1000)))})}</span>:<span className="qq-login-visual-label">{t(state?.connected?'social.login.verified':'social.login.privateAccount')}</span>}
    </div>
    <div className="qq-login-content">
      <div className="qq-login-heading"><h3>{t('social.login.title')}</h3><Hint text={t('social.login.hint')} side="down"/></div>
      <p className={`qq-login-state${code?' is-error':''}`} role={code?'alert':'status'}>{message}</p>
      {state?.connected&&state.actualSelfId?<p className="qq-login-identity">{t('social.verifiedIdentity',{id:state.actualSelfId})}</p>:null}
      {qr?<p className="qq-login-instruction">{t('social.login.scan')}</p>:null}
      <div className="qq-login-actions">
        {state&&!state.connected?<Button size="sm" disabled={busy||pending||state.status==='stopping'} onClick={onLogin}>{t(pending?'social.login.loggingIn':'social.login.begin')}</Button>:null}
        {state?.connected?<Button size="sm" variant="ghost" disabled={busy} onClick={onLogout}>{t('social.login.forget')}</Button>:null}
      </div>
      <p className="qq-login-footnote">{t('social.login.permissionNote')}</p>
    </div>
  </div>;
}
