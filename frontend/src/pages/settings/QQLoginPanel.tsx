import {useEffect,useRef,useState} from 'react';
import {useT} from '../../i18n';
import {observeQQRuntime,visibleQQRuntime,type QQLoginErrorCode,type QQRuntimeAction,type QQRuntimeState} from '../../services/qqRuntimeClient';
import type {SocialAccount} from '../../services/socialClient';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';

const PENDING=new Set<QQRuntimeState['status']>(['preparing','connecting','qr_pending','awaiting_confirmation','verifying']);

export default function QQLoginPanel({active,identityDirty,onAuthenticated,channel,connectionBusy,onConnect}:{active:boolean;identityDirty:boolean;onAuthenticated:()=>void;channel:SocialAccount;connectionBusy:boolean;onConnect:()=>void}){
  const t=useT();
  const [runtime,setRuntime]=useState<QQRuntimeState|null>(null);
  const [error,setError]=useState<QQLoginErrorCode|null>(null);
  const [busy,setBusy]=useState(false);
  const [pendingAction,setPendingAction]=useState<QQRuntimeAction|null>(null);
  const [confirmForget,setConfirmForget]=useState(false);
  const [visible,setVisible]=useState(()=>typeof document==='undefined'||document.visibilityState!=='hidden');
  const [now,setNow]=useState(Date.now);
  const observer=useRef<ReturnType<typeof observeQQRuntime>|null>(null);
  const authenticated=useRef(onAuthenticated);authenticated.current=onAuthenticated;
  const lastIdentity=useRef<string|null>(null);
  useEffect(()=>{
    const change=()=>setVisible(document.visibilityState!=='hidden');
    document.addEventListener('visibilitychange',change);return()=>document.removeEventListener('visibilitychange',change);
  },[]);
  useEffect(()=>{
    setRuntime(null);setError(null);setBusy(false);setPendingAction(null);setConfirmForget(false);
    if(!active||!visible)return;
    const observation=observeQQRuntime({onState:state=>{
      setRuntime(state);setNow(Date.now());
      if(state?.connected&&state.actualSelfId!==lastIdentity.current){lastIdentity.current=state.actualSelfId;authenticated.current();}
      else if(state&&!state.connected)lastIdentity.current=null;
    },onError:setError,onBusy:value=>{setBusy(value);if(!value)setPendingAction(null);}});
    observer.current=observation;observation.start();
    return()=>{observer.current=null;observation.dispose();};
  },[active,visible]);
  useEffect(()=>{
    if(!active||!visible||!runtime?.qr)return;
    const tick=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(tick);
  },[active,visible,runtime?.qr?.expiresAt]);
  const state=runtime?visibleQQRuntime(runtime,now):null;
  const code=error??state?.error;
  const isPending=state?PENDING.has(state.status):busy&&pendingAction!=='stop'&&pendingAction!=='forget'&&pendingAction!=='cancel';
  const canBegin=!identityDirty&&!busy&&!connectionBusy&&!isPending&&!state?.connected&&state?.status!=='stopping';
  const run=(action:QQRuntimeAction)=>{if(connectionBusy)return;setConfirmForget(false);setPendingAction(action);void observer.current?.act(action);};
  const message=code?t(`social.login.errors.${code}`):busy?t(pendingAction==='stop'?'social.login.states.stopping':pendingAction==='forget'?'social.login.forgetting':'social.login.states.preparing'):t(`social.login.states.${state?.status??'loading'}`);
  const qr=state?.qr;
  const managed=channel.transport==='managed'&&channel.enabled;
  const chatConnected=managed&&channel.status==='connected'&&channel.actualSelfId===state?.actualSelfId;
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
        {!state?.connected&&!qr?<Button size="sm" disabled={!canBegin} onClick={()=>run(state?.status==='expired'?'refresh':'begin')}>{t(busy||isPending?'social.login.preparing':state?.status==='expired'?'social.login.refresh':'social.login.begin')}</Button>:null}
        {qr?<Button size="sm" variant="ghost" disabled={busy||connectionBusy||identityDirty} onClick={()=>run('refresh')}>{t('social.login.refresh')}</Button>:null}
        {isPending?<Button size="sm" variant="ghost" disabled={connectionBusy} onClick={()=>run('cancel')}>{t('social.login.cancel')}</Button>:null}
        {state?.connected&&!chatConnected?<Button size="sm" disabled={busy||connectionBusy||channel.status==='quarantined'} onClick={onConnect}>{t(connectionBusy?'social.saving':'social.login.enableChat')}</Button>:null}
        {state?.connected?<Button size="sm" variant="ghost" disabled={busy||connectionBusy} onClick={()=>run('stop')}>{t('social.login.stop')}</Button>:null}
      </div>
      {state?.connected&&managed?<p className="qq-login-chat-state" role="status">{t(channel.status==='quarantined'?'social.login.chatQuarantined':chatConnected?'social.login.chatConnected':'social.login.chatConnecting')}</p>:null}
      {identityDirty?<p className="qq-login-footnote">{t('social.login.saveIdentity')}</p>:<p className="qq-login-footnote">{t('social.login.permissionNote')}</p>}
      <details className="qq-login-session"><summary>{t('social.login.session')}</summary>
        <p>{t('social.login.sessionHint')}</p>
        {confirmForget?<div className="qq-login-forget-confirm"><p>{t('social.login.forgetConfirm')}</p><Button size="sm" variant="ghost" onClick={()=>setConfirmForget(false)}>{t('common.cancel')}</Button><Button size="sm" disabled={busy||connectionBusy} onClick={()=>run('forget')}>{t('social.login.forget')}</Button></div>:<div className="qq-login-actions">{state?.running&&!state.connected?<Button size="sm" variant="ghost" disabled={busy||connectionBusy} onClick={()=>run('stop')}>{t('social.login.stop')}</Button>:null}<Button size="sm" variant="ghost" disabled={busy||connectionBusy||!state} onClick={()=>setConfirmForget(true)}>{t('social.login.forget')}</Button></div>}
      </details>
    </div>
  </div>;
}
