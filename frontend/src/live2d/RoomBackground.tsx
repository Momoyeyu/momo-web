import {useEffect,useState,useSyncExternalStore} from 'react';
import {roomPhase,roomImages,type RoomPhase} from './roomTime';
import {activeResource,observeMods,subscribeMods} from '../services/mods';
import {runtimeFetch} from '../services/runtime';
import {ambient} from '../audio/ambient';

const backgroundUrl=()=>activeResource('background');
const musicUrl=()=>activeResource('bgm');
function ModBackground({url}:{url:string}){
 const [art,setArt]=useState<string|null>(null);
 useEffect(()=>{
   const controller=new AbortController();
   let objectUrl:string|undefined;
   async function load(path:string){
     const response=await runtimeFetch(path,{signal:controller.signal});
     if (!response.ok) return;
     const blob=await response.blob();
     if (controller.signal.aborted) return;
     objectUrl=URL.createObjectURL(blob);
     const img=new Image();
     img.src=objectUrl;
     await img.decode();
     if (!controller.signal.aborted) setArt(objectUrl);
   }
   void load(url).catch(()=>{if (objectUrl) URL.revokeObjectURL(objectUrl);});
   return ()=>{controller.abort();if (objectUrl) URL.revokeObjectURL(objectUrl);};
 },[url]);
 return art ? <div className="room-lighting" data-mod-background="" style={{backgroundImage:`url(${art})`}}/> : null;
}

/** Persistent room lighting; does not remount the avatar or follow page changes. */
export default function RoomBackground(){
 const url=useSyncExternalStore(subscribeMods,backgroundUrl);
 const music=useSyncExternalStore(subscribeMods,musicUrl);
 useEffect(observeMods,[]);
 useEffect(()=>{ambient.dailyTrack(music);},[music]);
 const [phase,setPhase]=useState<RoomPhase>('day');
 useEffect(()=>{
  let disposed=false,revision=0;
  const sync=()=>{
   if(document.hidden)return;
   const target=roomPhase(new Date().getHours());const rev=++revision;
   const image=new Image();image.src=roomImages[target];
   void image.decode().then(()=>{if(!disposed&&rev===revision)setPhase(target);}).catch(()=>{});
  };
  sync();const timer=setInterval(sync,60_000);
  document.addEventListener('visibilitychange',sync);window.addEventListener('focus',sync);
  return()=>{disposed=true;clearInterval(timer);document.removeEventListener('visibilitychange',sync);window.removeEventListener('focus',sync);};
 },[]);
 return <div className="room-background" data-room-phase={phase} aria-hidden="true">
  {(Object.keys(roomImages) as RoomPhase[]).map(key=><div key={key} className="room-lighting" style={{backgroundImage:`url(${roomImages[key]})`,opacity:key===phase?1:0}}/>)}
  {url && <ModBackground key={url} url={url}/>}
 </div>;
}
