import {useEffect} from 'react';
import {readMinecraftStatus} from './minecraftClient';
import {meetingIdentity,meetingSnapshot} from './meetingClient';
/** Only schedules the existing chat engine; local-body heartbeats belong to Python. */
export function useMinecraftDecisions(active:boolean){
 useEffect(()=>{
  if(!active)return;
  let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{
   try{
    if(meetingIdentity()&&!meetingSnapshot().attention.focus){
     const game=await readMinecraftStatus();
     if(!disposed&&game.active&&game.autonomous&&!game.paused&&game.decisionNeeded){
      const {getChatEngine}=await import('../chat/engineInstance');
      if(!disposed)getChatEngine().sendGameDecision(game.generation);
     }
    }
   }catch{/* A failed read never renews body control or creates an inferred action. */}
   if(!disposed)timer=setTimeout(()=>void poll(),2000);
  };
  void poll();return()=>{disposed=true;clearTimeout(timer);};
 },[active]);
}
