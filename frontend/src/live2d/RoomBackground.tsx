import {useEffect,useState} from 'react';
import {roomPhase,roomImages,type RoomPhase} from './roomTime';
/** Persistent room lighting; does not remount the avatar or follow page changes. */
export default function RoomBackground(){
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
 </div>;
}
