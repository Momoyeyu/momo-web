import {useRef,useState} from 'react';
import {useT} from '../../i18n';
import type {SocialPeer} from '../../services/socialClient';
import {addQQContacts} from '../../services/qqAllowlist';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';

/** Explicit Add keeps partially typed numbers out of automatically saved policy. */
export default function QQScopeEditor({id,label,hint,placeholder,listLabel,removeLabel,emptyHint,value,onChange}:{
  id:string;label:string;hint:string;placeholder:string;listLabel:string;removeLabel:string;emptyHint:string;
  value:SocialPeer[];onChange:(value:SocialPeer[])=>void;
}){
  const t=useT();const [input,setInput]=useState('');const [error,setError]=useState<string|null>(null);
  const ref=useRef<HTMLInputElement>(null);
  const add=()=>{
    try{const next=addQQContacts(input,value);onChange(next);setInput('');setError(null);ref.current?.focus();}
    catch(cause){setError(cause instanceof Error?cause.message:'invalid');}
  };
  return <div className="social-scope-editor">
    <div className="social-scope-heading"><label htmlFor={id}>{label}</label><Hint text={`${hint}${value.length===0?` ${emptyHint}`:''}`} side="down"/></div>
    <div className="social-contact-add"><input ref={ref} id={id} type="text" inputMode="numeric" autoComplete="off" value={input} placeholder={placeholder} aria-invalid={!!error} aria-describedby={error?`${id}-error`:undefined} onChange={event=>{setInput(event.target.value);setError(null);}} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();add();}}} spellCheck={false}/><Button size="sm" onClick={add}>{t('social.addContact')}</Button></div>
    {error?<p id={`${id}-error`} role="alert" className="social-error">{t(`social.contactErrors.${error}`)}</p>:null}
    {value.length>0?<ul className="social-contact-list" aria-label={listLabel}>{value.map(peer=><li key={peer.peerId}><span>{peer.label||peer.peerId}{peer.label?<small>{peer.peerId}</small>:null}</span><Button variant="ghost" size="sm" aria-label={removeLabel.replace('{id}',peer.peerId)} onClick={()=>{onChange(value.filter(item=>item.peerId!==peer.peerId));setError(null);}}>{t('social.removeContactButton')}</Button></li>)}</ul>:null}
  </div>;
}
