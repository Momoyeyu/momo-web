import type {PhoneViewProps} from './registry';
import {useT} from '../i18n';
import Button from '../ui/Button';
export default function QQPhoneView({data,peer,setPeer,setApp,choosePeer,messages,loading,cursor,earlier}:PhoneViewProps){
 const t=useT();
 return <><header className="phone-app-header"><Button variant="ghost" onClick={()=>peer?setPeer(undefined):setApp(null)} aria-label={t('phone.back')}>‹</Button><span>{peer??'QQ'}</span></header>
  <div className="phone-scroll">{!peer?data?.conversations.map(c=><button className="phone-conversation" key={c.id} onClick={()=>choosePeer(c.id)}><strong>{c.kind==='group'?t('phone.group')+' ':''}{c.id}{c.pending>0&&<i className="phone-dot"/>}</strong><span>{c.preview}</span></button>):<>
   {(cursor===undefined?data?.hasMore:cursor!==null)&&<Button size="sm" disabled={loading} onClick={()=>void earlier()}>{t('phone.earlier')}</Button>}
   {messages.map(m=><div key={m.id} className={`phone-message ${m.direction}`}><small>{m.speaker} · {t(m.direction==='out'?'phone.delivered':m.status==='processing'?'phone.processing':['queued','held_focus','held_inactive','held_paused','held_interrupt'].includes(m.status)?'phone.pending':'phone.received')}</small><p>{m.text}</p></div>)}
   {data?.operations.filter(o=>!['completed','delivered'].includes(o.status)).map(o=><div className="phone-operation" key={o.id}>{o.action} · {t(['failed','unknown'].includes(o.status)?'phone.'+o.status:'phone.processing')}</div>)}
  </>}{!peer&&!data?.conversations.length&&<p className="phone-empty">{t('phone.noMessages')}</p>}</div></>;
}
