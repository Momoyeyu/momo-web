import {useEffect,useRef,useState} from 'react';
import type {ImageRef} from '../lib/types';
import {runtimeFetch} from '../services/runtime';
import {deleteImage,uploadImage} from '../services/visionClient';
export interface ImageDraft {key:string;file:File;url:string;image?:ImageRef;pending:boolean;error?:string;abort:AbortController}
/** Draft lifetime is independent of server turns. Removed/late uploads never return. */
export function useImageDraft(){
 const [items,setItems]=useState<ImageDraft[]>([]),[error,setError]=useState('');
 const current=useRef<ImageDraft[]>([]),alive=useRef(true);
 const publish=()=>{if(alive.current)setItems([...current.current]);};
 const discard=(item:ImageDraft,remove=true)=>{item.abort.abort();URL.revokeObjectURL(item.url);if(remove&&item.image)void deleteImage(item.image.id).catch(()=>{});};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;for(const item of current.current)discard(item);current.current=[];};},[]);
 const upload=(item:ImageDraft)=>{
  if(item.image){void deleteImage(item.image.id).catch(()=>{});item.image=undefined;}
  item.pending=true;item.error=undefined;item.abort=new AbortController();publish();
  void uploadImage(item.file,item.abort.signal).then(async image=>{
   if(!alive.current||!current.current.includes(item)){void deleteImage(image.id).catch(()=>{});return;}
   item.image=image;
   if(image.animated){
    const response=await runtimeFetch('/api/vision/images/'+image.id,{signal:item.abort.signal});
    if(!response.ok)throw new Error('vision.uploadFailed');
    const blob=await response.blob();if(item.abort.signal.aborted||!current.current.includes(item))return;
    const url=URL.createObjectURL(blob);URL.revokeObjectURL(item.url);item.url=url;
   }
  }).catch(cause=>{if(!item.abort.signal.aborted)item.error=cause instanceof Error?cause.message:'vision.uploadFailed';})
   .finally(()=>{if(current.current.includes(item)){item.pending=false;publish();}});
 };
 const add=(files:File[])=>{
  setError('');
  if(current.current.length+files.length>4){setError('vision.count');return;}
  if(files.some(file=>file.size>10*1024*1024)){setError('vision.size');return;}
  for(const file of files){
   const item:ImageDraft={key:crypto.randomUUID(),file,url:URL.createObjectURL(file),pending:true,abort:new AbortController()};
   current.current.push(item);upload(item);
  }
  publish();
 };
 const remove=(key:string)=>{const item=current.current.find(item=>item.key===key);if(!item)return;current.current=current.current.filter(candidate=>candidate!==item);setError('');discard(item);publish();};
 // Do not delete server assets here: the accepted turn owns them now.
 const accepted=()=>{for(const item of current.current)discard(item,false);current.current=[];setError('');publish();};
 return {items,error,add,remove,retry:upload,accepted,ready:items.length>0&&items.every(item=>item.image&&!item.pending&&!item.error)};
}
