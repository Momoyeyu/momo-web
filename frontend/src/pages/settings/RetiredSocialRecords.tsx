import {useEffect,useId,useRef,useState} from 'react';
import {useT} from '../../i18n';
import {endRetiredSocialWait,type RetiredSocialRecord} from '../../services/socialClient';
import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';

export default function RetiredSocialRecords({records,onChanged}:{records:RetiredSocialRecord[];onChanged:(records:RetiredSocialRecord[])=>void}){
  const t=useT();
  const [confirmed,setConfirmed]=useState<string|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const [error,setError]=useState(false);
  const confirmationId=useId();
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const endWait=async(commandId:string)=>{
    if(pending||confirmed!==commandId)return;
    setPending(commandId);setError(false);
    try{
      const remaining=await endRetiredSocialWait(commandId);
      if(alive.current){setConfirmed(null);onChanged(remaining);}
    }catch{if(alive.current)setError(true);}
    finally{if(alive.current)setPending(null);}
  };
  return <details className="social-retired-records">
    <summary>{t('social.retiredTitle',{count:String(records.length)})}</summary>
    <p className="social-help muted">{t('social.retiredHint')}</p>
    {error && <p className="social-error" role="alert">{t('social.retiredEndWaitError')}</p>}
    {records.map((record,index)=><article className="social-record" key={record.commandId}>
      <div className="social-record-top"><strong>{t('social.retiredSource')}</strong><span>{t('social.delivery.unknown')}</span></div>
      <dl className="social-retired-metadata"><div><dt>{t('social.retiredAccount')}</dt><dd>{record.accountId||t('social.retiredMetadataMissing')}</dd></div><div><dt>{t('social.retiredPeer')}</dt><dd>{record.peerId||t('social.retiredMetadataMissing')}</dd></div></dl>
      <code>{record.commandId}</code><time dateTime={record.createdAt}>{record.createdAt}</time>
      <div className="social-recovery"><p>{t('social.retiredUnknown')}</p>
        <div className="social-retired-confirm"><Checkbox id={`${confirmationId}-${index}`} checked={confirmed===record.commandId} disabled={pending!==null} onChange={event=>setConfirmed(event.target.checked?record.commandId:null)}/><label htmlFor={`${confirmationId}-${index}`}>{t('social.retiredExecutorStopped')}</label></div>
        <Button size="sm" variant="ghost" disabled={pending!==null||confirmed!==record.commandId} onClick={()=>void endWait(record.commandId)}>{t(pending===record.commandId?'social.endingRetiredWait':'social.endRetiredWait')}</Button>
      </div>
    </article>)}
  </details>;
}
