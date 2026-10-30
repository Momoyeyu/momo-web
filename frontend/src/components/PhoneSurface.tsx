import {createPortal} from 'react-dom';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {phoneSnapshot,type PhoneSnapshot,type PhoneMessage} from '../services/phoneClient';
import {phoneApps,phoneRevision,subscribePhoneApps} from '../phone/registry';
import '../phone/qqApp';
import PhoneField from '../phone/PhoneField';
import {mergePhoneMessages,phoneIdentityChanged} from '../phone/projection';
import {autoPhone} from '../phone/visibility';
import type {AttentionState} from '../services/meetingClient';
import {meetingSnapshot} from '../services/meetingClient';
import {useT} from '../i18n';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import '../styles/phone.css';
const signalGlyphs=Array.from({length:24},(_,i)=><span key={i} style={{'--i':i} as React.CSSProperties}>{i%3?'01':'10'}</span>);
// Module state survives settings/backlog, but a new Boot resets visibility preference.
let session={lease:'',open:false,suppressed:false};
export default function PhoneSurface({active,attention}:{active:boolean;attention:AttentionState}){
 const t=useT();useSyncExternalStore(subscribePhoneApps,phoneRevision);
 const [data,setData]=useState<PhoneSnapshot|null>(null),[failed,setFailed]=useState(false);
 const [open,setOpen]=useState(session.open),[app,setApp]=useState<string|null>(null),[peer,setPeer]=useState<string>();
 const [older,setOlder]=useState<PhoneMessage[]>([]),[loading,setLoading]=useState(false);
 const [cursor,setCursor]=useState<number|null|undefined>();
 const peerRef=useRef(peer);peerRef.current=peer;
 const revision=useRef(0),accountRef=useRef('');
 const changePeer=(value:string|undefined)=>{revision.current++;setPeer(value);setOlder([]);setCursor(undefined);setData(old=>old?{...old,messages:[],operations:[]}:old);};
 const changeApp=(value:string|null)=>{if(value!==app){changePeer(undefined);setData(null);}setApp(value);};
 const lease=meetingSnapshot().lease?.leaseId??'';
 const activity=data?data.activity:attention.activity;
 const busyApp=phoneApps().find(a=>a.source===(activity?.toolSource??activity?.source));
 useEffect(()=>{
  if(session.lease!==lease){session={lease,open:false,suppressed:false};revision.current++;accountRef.current='';setOlder([]);setCursor(undefined);setOpen(false);setApp(null);setPeer(undefined);setData(null);}
 },[lease]);
 useEffect(()=>{
  if(!active)return;
  let stopped=false,timer:ReturnType<typeof setTimeout>;let request:AbortController;
  const poll=async()=>{
   request=new AbortController();
   const timeout=setTimeout(()=>request.abort(),8000);
   try{const next=await phoneSnapshot(peer,undefined,request.signal,app??undefined);if(stopped)return;
    const identity=JSON.stringify([app??'momo-qq',next.accountKey]);
    const changed=phoneIdentityChanged(accountRef.current,identity);
    if(changed){revision.current++;setPeer(undefined);setOlder([]);setCursor(undefined);}
    accountRef.current=identity;setData(old=>({...next,messages:changed?[]:mergePhoneMessages(old?.messages??[],next.messages)}));setFailed(false);
   }catch{if(!stopped){setFailed(true);setData(null);}}
   clearTimeout(timeout);if(!stopped)timer=setTimeout(poll,1500);
  };void poll();return()=>{stopped=true;clearTimeout(timer);request?.abort();};
 },[active,peer,app]);
 useEffect(()=>{
  if(!active)return;
  const next=autoPhone(session.open,session.suppressed,!!busyApp,attention.focus);
  if(next&&!session.open){session.open=true;setOpen(true);setApp(busyApp?.id??null);}
 },[active,busyApp?.id,attention.focus]);
 useEffect(()=>{
  if(active&&open&&busyApp){changeApp(busyApp.id);if(activity?.peerId)changePeer(activity.peerId);}
 },[active,open,activity?.runId,activity?.peerId,busyApp?.id]);
 const choosePeer=(value:string)=>changePeer(value);
 const toggle=()=>{session.open=!open;if(!session.open)session.suppressed=true;setOpen(session.open);};
 const apps=phoneApps().filter(a=>data?.apps.some(p=>p.id===a.id));
 const current=apps.find(a=>a.id===app);
 const messages=[...new Map([...older,...(data?.messages??[])].map(m=>[m.id,m])).values()];
 const earlier=async()=>{const before=cursor===undefined?data?.nextBefore:cursor;if(before==null||loading)return;setLoading(true);const selected=peer,version=revision.current,identity=accountRef.current;
  try{const page=await phoneSnapshot(peer,before,undefined,app??undefined);if(peerRef.current!==selected||revision.current!==version||accountRef.current!==identity||JSON.stringify([app??'momo-qq',page.accountKey])!==identity)return;setOlder(old=>[...page.messages,...old]);setCursor(page.nextBefore);setData(old=>old?{...old,nextBefore:page.nextBefore,hasMore:page.hasMore}:old);}
  catch{setFailed(true);}finally{setLoading(false);}};

 return <>{createPortal(<section className={`phone-surface ${open&&active?'is-open':'is-closed'}`} inert={!open||!active} aria-hidden={!open||!active} aria-label={t('phone.title')}>
  <div className="phone-signal" aria-hidden="true">{signalGlyphs}</div>
  <div className="phone-glass"><div className="phone-top"><span>momo</span><span>{attention.focus?t('phone.focus'):busyApp?t('phone.processing'):t('phone.standby')}</span><Button variant="ghost" className="phone-nav phone-close tip" data-tip={t('phone.close')} onClick={toggle} aria-label={t('phone.close')}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg></Button></div>
   {failed?<div className="phone-empty" role="status">{t('phone.unavailable')}</div>:current?.render?current.render({data,peer,setPeer:changePeer,setApp:changeApp,choosePeer,messages,loading,cursor,earlier}):<div className="phone-home"><PhoneField/><div className="phone-apps">{apps.map(a=><button className="phone-app" key={a.id} onClick={()=>{changeApp(a.id);}}><span className="phone-app-icon">{a.icon}{(data?.apps.find(p=>p.id===a.id)?.pending??0)>0&&<i className="phone-dot"/>}</span><span>{data?.apps.find(p=>p.id===a.id)?.name}</span></button>)}</div><p className="phone-empty">{current?t('phone.standby'):apps.length?'':t('phone.empty')}</p></div>}
   <button className="phone-home-bar" aria-label={t('phone.home')} onClick={()=>{changeApp(null);}}/>
  </div></section>,document.querySelector('.app-stage')??document.body)}
  <Button className={`tb phone-toggle tip${open?' is-active':''}`} data-tip={t('phone.title')} onClick={toggle} aria-label={t('phone.title')} aria-expanded={open}><Icon name="phone"/>{(data?.pending??0)>0&&<i className="phone-dot"/>}</Button></>;
}
