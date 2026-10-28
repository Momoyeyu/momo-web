import {useEffect,useRef,useState} from 'react';
import {useT} from '../../i18n';
import {qqMedia,uploadQQMedia,removeQQMedia,type QQMedia} from '../../services/socialClient';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';

export default function QQMediaLibrary(){
  const t=useT();const [items,setItems]=useState<QQMedia[]>([]);const [busy,setBusy]=useState(true);const [error,setError]=useState<string|null>(null);
  const picker=useRef<HTMLInputElement>(null);const requests=useRef(new AbortController());
  useEffect(()=>{
    const controller=new AbortController();requests.current=controller;
    void qqMedia(controller.signal).then(result=>{if(!controller.signal.aborted){if(!Array.isArray(result.items))throw new Error('protocol');setItems(result.items);}}).catch(()=>{if(!controller.signal.aborted)setError('social.mediaError');}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[]);
  const upload=async(file:File)=>{
    if(file.size>8*1024*1024||file.size===0){setError('social.mediaSizeError');return;}
    setBusy(true);setError(null);const signal=requests.current.signal;
    try{const item=await uploadQQMedia(file,signal);if(!signal.aborted)setItems(current=>[...current.filter(old=>old.mediaId!==item.mediaId),item]);}
    catch{if(!signal.aborted)setError('social.mediaError');}
    finally{if(!signal.aborted)setBusy(false);}
  };
  const remove=async(mediaId:string)=>{
    setBusy(true);setError(null);const signal=requests.current.signal;
    try{await removeQQMedia(mediaId,signal);if(!signal.aborted)setItems(current=>current.filter(item=>item.mediaId!==mediaId));}
    catch{if(!signal.aborted)setError('social.mediaError');}
    finally{if(!signal.aborted)setBusy(false);}
  };
  return <section className="social-policy-section social-media-library" aria-label={t('social.mediaLibrary')}>
    <div className="social-library-heading"><div className="social-permission-heading"><h3>{t('social.mediaLibrary')}</h3><Hint text={t('social.mediaLibraryHint')} side="down"/></div><Button variant="ghost" size="sm" disabled={busy} onClick={()=>picker.current?.click()}>{t(busy?'social.loading':'social.mediaUpload')}</Button></div>
    <input ref={picker} className="social-file-picker" type="file" aria-label={t('social.mediaUpload')} accept=".png,.jpg,.jpeg,.webp,.wav,.mp3,.ogg,.mp4,.pdf,.txt,.bin" onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void upload(file);}}/>
    {error?<p role="alert" className="social-error">{t(error)}</p>:null}
    {items.length>0?<ul className="social-media-list">{items.map(item=><li key={item.mediaId}><span className="social-media-name" title={item.name}>{item.name}</span><span className="social-media-size">{Math.max(1,Math.ceil(item.size/1024))} KB</span><Button variant="ghost" size="sm" disabled={busy} aria-label={t('social.mediaRemove',{name:item.name})} onClick={()=>void remove(item.mediaId)}>{t('social.removeContactButton')}</Button></li>)}</ul>:null}
  </section>;
}
