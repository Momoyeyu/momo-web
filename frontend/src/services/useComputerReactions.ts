import {useEffect,useRef} from 'react';
import {captureDesktop,computerSnapshot,hasSharedScreen,readComputer} from './computerClient';
import {desktopWindowAvailable} from './desktopWindow';
import {meetingIdentity,meetingSnapshot} from './meetingClient';

/** Chat owns a single scheduler across normal/pet mode. Browser sharing owns its own frames. */
export function useComputerReactions(active:boolean){
 const lastReaction=useRef(0);
 useEffect(()=>{
  if(!active)return;
  let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const canReact=()=>{
   const {status}=computerSnapshot();
   return !disposed&&!!meetingIdentity()&&!meetingSnapshot().attention.focus&&
    !!status?.proactive&&status.reactions&&status.desktopAllowed!==false&&!status.desktopError;
  };
  const poll=async()=>{
   try{
    await readComputer();
    if(desktopWindowAvailable()&&!hasSharedScreen()&&canReact()){
     await captureDesktop();
     const fresh=computerSnapshot().status;
     if(canReact()&&!computerSnapshot().error&&fresh?.observing&&Date.now()-lastReaction.current>=30000){
      const {getChatEngine}=await import('../chat/engineInstance');
      if(canReact()){
       lastReaction.current=Date.now();
       getChatEngine().sendScreenReaction(fresh.generation);
      }
     }
    }
   }catch{/* Retry status without assuming capture permission. */}
   if(!disposed)timer=setTimeout(()=>void poll(),2500);
  };
  void poll();
  return()=>{disposed=true;clearTimeout(timer);};
 },[active]);
}
