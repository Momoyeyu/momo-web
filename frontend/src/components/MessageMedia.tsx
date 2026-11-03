import {useEffect, useState} from 'react';
import {desktop, runtimeFetch} from '../services/runtime';
import type {ImageRef} from '../lib/types';
import ImageAttachments from './ImageAttachments';

function VoiceClip({id}: {id:string}) {
  const [url,setUrl] = useState('');
  const path = '/api/chat/voice/' + encodeURIComponent(id);
  useEffect(() => {
    if (!desktop()) return;
    const controller = new AbortController();
    let objectUrl = '';
    setUrl('');
    void runtimeFetch(path,{signal:controller.signal})
      .then(response => response.ok ? response.blob() : undefined)
      .then(blob => {
        if (blob && !controller.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setUrl(objectUrl);
        }
      }).catch(() => {});
    return () => {controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl);};
  }, [path]);
  const src = desktop() ? url : path;
  return src ? <audio controls preload="none" src={src} style={{maxWidth:'100%'}}/> : null;
}

export default function MessageMedia({images, voices}: {images?:ImageRef[];voices?:string[]}) {
  return <><ImageAttachments images={images}/>{voices?.map(id => <VoiceClip key={id} id={id}/>)}</>;
}
