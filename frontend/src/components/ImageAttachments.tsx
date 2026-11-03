import {useEffect,useState} from 'react';
import Icon from '../ui/Icon';
import {deleteImage} from '../services/visionClient';
import Modal from '../ui/Modal';
import {runtimeFetch} from '../services/runtime';
import type {ImageRef} from '../lib/types';
import {useT} from '../i18n';
import '../styles/images.css';
function ImageAttachment({image}:{image:ImageRef}){
 const t=useT(),[url,setUrl]=useState(''),[failed,setFailed]=useState(false),[expanded,setExpanded]=useState(false),[deleting,setDeleting]=useState(false);
 useEffect(()=>{
  const abort=new AbortController();let objectUrl='';setUrl('');setFailed(false);
  const unavailable=()=>{abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl='';setUrl('');setFailed(true);setExpanded(false);};
  const deleted=(event:Event)=>{if((event as CustomEvent<string>).detail===image.id)unavailable();};
  if(image.unavailable){unavailable();return;}
  window.addEventListener('momo:image-deleted',deleted);
  void runtimeFetch('/api/vision/images/'+image.id,{signal:abort.signal}).then(response=>{if(!response.ok)throw new Error();return response.blob();}).then(blob=>{
   if(abort.signal.aborted)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);
  }).catch(()=>{if(!abort.signal.aborted)setFailed(true);});
  return()=>{window.removeEventListener('momo:image-deleted',deleted);abort.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[image.id,image.unavailable]);
 return <>{url?<button className="image-attachment" aria-label={t('vision.preview')} onClick={()=>setExpanded(true)}><img src={url} alt={t('vision.image')} width={image.width} height={image.height}/></button>:<span className="image-attachment muted">{t(failed?'vision.unavailable':'vision.loading')}</span>}
 {expanded&&<Modal className="image-lightbox" label={t('vision.preview')} onClose={()=>setExpanded(false)}><button autoFocus aria-label={t('vision.close')} onClick={()=>setExpanded(false)}>×</button><button className="image-forget" aria-label={t('vision.delete')} disabled={deleting} onClick={()=>{if(!window.confirm(t('vision.deleteConfirm')))return;setDeleting(true);void deleteImage(image.id,true).then(()=>{setExpanded(false);setUrl('');setFailed(true);}).catch(()=>window.alert(t('vision.unavailable'))).finally(()=>setDeleting(false));}}><Icon name="trash"/></button><img src={url} alt={t('vision.image')}/></Modal>}</>;
}
export default function ImageAttachments({images}:{images?:ImageRef[]}){
 if(!images?.length)return null;
 return <div className="image-attachments">{images.map(image=><ImageAttachment key={image.id} image={image}/>)}</div>;
}
