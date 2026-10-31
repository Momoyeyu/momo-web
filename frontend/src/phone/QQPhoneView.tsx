import {useLayoutEffect,useRef} from 'react';
import {usePhoneTyping} from './usePhoneTyping';
import type {PhoneViewProps} from './registry';
import {useT} from '../i18n';
import Button from '../ui/Button';
export default function QQPhoneView({data,peer,setPeer,setApp,choosePeer,messages,loading,cursor,earlier}:PhoneViewProps){
 const t=useT();
 const scroll=useRef<HTMLDivElement>(null),follow=useRef(true),anchor=useRef({height:0,top:0});
 const {visible,typing}=usePhoneTyping(data?.draft,messages,`${data?.accountKey}:${peer}`);
 useLayoutEffect(()=>{follow.current=true;},[peer]);
 useLayoutEffect(()=>{
  const el=scroll.current;if(!el)return;
  if(follow.current)el.scrollTop=el.scrollHeight;
  else if(loading===false&&anchor.current.height){el.scrollTop=anchor.current.top+el.scrollHeight-anchor.current.height;anchor.current.height=0;}
 },[messages,typing,peer,loading]);
 return <><header className="phone-app-header"><Button variant="ghost" className="phone-nav tip" data-tip={t('phone.back')} onClick={()=>peer?setPeer(undefined):setApp(null)} aria-label={t('phone.back')}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></Button><span className="phone-app-title">{peer??'QQ'}</span></header>
  <div className="phone-scroll" ref={scroll} onScroll={()=>{const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<32;}}>{!peer?data?.conversations.map(c=><button className="phone-conversation" key={c.id} onClick={()=>choosePeer(c.id)}><strong>{c.kind==='group'?t('phone.group')+' ':''}{c.id}{c.pending>0&&<i className="phone-dot"/>}</strong><span>{c.preview}</span></button>):<>
   {(cursor===undefined?data?.hasMore:cursor!==null)&&<Button size="sm" disabled={loading} onClick={()=>{const el=scroll.current;if(el)anchor.current={height:el.scrollHeight,top:el.scrollTop};void earlier();}}>{t('phone.earlier')}</Button>}
   {visible.map(m=><div key={m.id} className={`phone-message ${m.direction}`}><small>{m.speaker} · {t(m.direction==='out'?'phone.delivered':m.status==='processing'?'phone.processing':['queued','held_focus','held_inactive','held_paused','held_interrupt'].includes(m.status)?'phone.pending':'phone.received')}</small><p>{m.text}</p></div>)}
   {typing!==null&&<div className="phone-typing" role="status"><span className="phone-typing-dots" aria-hidden="true">···</span><textarea readOnly value={typing} aria-label={t('phone.typing')} rows={3}/></div>}
   {data?.operations.filter(o=>!['completed','delivered'].includes(o.status)).map(o=><div className="phone-operation" key={o.id}>{o.action} · {t(['failed','unknown'].includes(o.status)?'phone.'+o.status:'phone.processing')}</div>)}
  </>}{!peer&&!data?.conversations.length&&<p className="phone-empty">{t('phone.noMessages')}</p>}</div></>;
}
