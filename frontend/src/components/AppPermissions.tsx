import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {useT} from '../i18n';
import {apiJson,jsonInit} from '../services/http';
import {meetingIdentity,meetingSnapshot,subscribeMeeting} from '../services/meetingClient';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
type Grant={appId:string;appName:string;bundleId:string;appPath:string;capabilities:string[]};
type Request=Grant&{id:string;reason:string;status:string};
export default function AppPermissions({manage=false}:{manage?:boolean}){
 const t=useT(),meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot),[pending,setPending]=useState<Request[]>([]),[grants,setGrants]=useState<Grant[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const resumeEpoch=useRef(0);
 useEffect(()=>()=>{resumeEpoch.current++;},[]);
 useEffect(()=>{if(meeting.state!=='active')resumeEpoch.current++;},[meeting.state]);
 const read=async()=>{const result=await apiJson<{pending:Request[];allowlist:Grant[]}>('/api/computer/approvals');setPending(result.pending);setGrants(result.allowlist);};
 useEffect(()=>{if(meeting.state!=='active'&&!manage)return;let live=true;let timer:ReturnType<typeof setTimeout>;const poll=async()=>{try{if(live)await read();}catch{/* Keep last visible request; never approve on an error. */}if(live)timer=setTimeout(()=>void poll(),1500);};void poll();return()=>{live=false;clearTimeout(timer);};},[meeting.state,manage]);
 const run=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError(false);try{await fn();await read();}catch{setError(true);}finally{setBusy(false);}};
 if(manage)return <section><h4>{t('permissions.allowed')}</h4>{grants.length===0&&<p className="muted">{t('permissions.empty')}</p>}{grants.map(g=><div className="permission-app" key={g.appId}><div><strong>{g.appName}</strong><small>{g.bundleId}</small><span>{g.capabilities.map(c=>t('permissions.'+c)).join(' · ')}</span></div><Button variant="ghost" disabled={busy} onClick={()=>void run(()=>apiJson('/api/computer/permissions/'+encodeURIComponent(g.appId),jsonInit('DELETE',{...meetingIdentity()})))}>{t('permissions.revoke')}</Button></div>)}{error&&<p role="alert">{t('permissions.error')}</p>}</section>;
 const request=pending[0];if(meeting.state!=='active')return null;
 if(!request)return error?<Modal className="extension-modal" label={t('permissions.title')} onClose={()=>setError(false)}><p role="alert">{t('permissions.error')}</p><Button onClick={()=>setError(false)}>{t('browser.dismiss')}</Button></Modal>:null;
 const decide=(decision:string)=>void run(async()=>{
  const owner=meetingIdentity();if(!owner)throw new Error('No owner');
  const epoch=++resumeEpoch.current;
  await apiJson('/api/computer/approvals/'+encodeURIComponent(request.id)+'/decision',jsonInit('POST',{...owner,decision}));
  if(decision!=='deny'){
   const deadline=Date.now()+30000;
   while(true){
    const current=meetingIdentity();if(epoch!==resumeEpoch.current||current?.leaseId!==owner.leaseId||current?.clientId!==owner.clientId)return;
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('Approval resume timed out');
    const result=await apiJson<{waiting?:boolean}>('/api/computer/native/resume',{...jsonInit('POST',{...owner,requestId:request.id}),signal:AbortSignal.timeout(Math.min(10000,remaining))});
    if(!result.waiting)break;
    if(Date.now()>=deadline)throw new Error('Approval resume timed out');
    await new Promise(resolve=>setTimeout(resolve,500));
   }
  }
  window.dispatchEvent(new CustomEvent('momo:app-permission',{detail:{id:request.id,decision}}));
 });
 return <Modal className="extension-modal" label={t('permissions.title')} onClose={()=>{if(!busy)decide('deny');}}><h3>{t('permissions.title')}</h3><strong>{request.appName}</strong><small>{request.bundleId}</small><p>{request.reason}</p><ul>{request.capabilities.map(c=><li key={c}>{t('permissions.'+c)}</li>)}</ul><div className="plugin-library-actions"><Button variant="ghost" disabled={busy} onClick={()=>decide('deny')}>{t('permissions.deny')}</Button><Button disabled={busy} onClick={()=>decide('once')}>{t('permissions.once')}</Button><Button variant="ghost" disabled={busy} onClick={()=>decide('always')}>{t('permissions.always')}</Button></div>{error&&<p role="alert">{t('permissions.error')}</p>}</Modal>;
}
