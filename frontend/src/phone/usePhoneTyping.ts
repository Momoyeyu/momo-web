import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {getState,subscribe} from '../lib/store';
import {charsPerSec} from '../chat/pacing';
import type {PhoneMessage} from '../services/phoneClient';
/** Generated text is a draft; only real delivered messages become bubbles. */
export function usePhoneTyping(draft:{runId:string;text:string}|null|undefined,messages:PhoneMessage[],identity:string){
 useSyncExternalStore(subscribe,getState);
 const baseline=useRef<{identity:string;ids:Set<string>|null}|null>(null);
 if(!baseline.current||baseline.current.identity!==identity)baseline.current={identity,ids:null};
 if(!baseline.current.ids&&(messages.length||draft))baseline.current.ids=new Set(messages.filter(m=>m.direction==='out').map(m=>m.id));
 const fresh=messages.filter(m=>m.direction==='out'&&!baseline.current!.ids?.has(m.id));
 const latest=fresh.at(-1);
 const key=latest?.id.replace(/^out:/,'')??draft?.runId??'';
 const target=latest?.text??draft?.text??'';
 const [display,setDisplay]=useState({key:'',text:''});
 const speed=getState().settings.general.textSpeed;
 useEffect(()=>{
  if(!key)return;
  const rate=charsPerSec(speed),units=Array.from(target);
  const tick=setInterval(()=>setDisplay(old=>{
   const count=old.key===key?Array.from(old.text).length:0;
   if(count>=units.length&&old.key===key){clearInterval(tick);return old;}
   return {key,text:units.slice(0,rate===Infinity?units.length:Math.min(units.length,count+Math.max(1,Math.round(rate*.04)))).join('')};
  }),40);
  return()=>clearInterval(tick);
 },[key,target,speed]);
 const ready=display.key===key&&display.text===target;
 const visible=messages.filter(m=>m.direction!=='out'||baseline.current!.ids?.has(m.id)||m.id!==latest?.id||ready);
 return {visible,typing:target&&(!latest||!ready)?(display.key===key?display.text:''):null};
}
