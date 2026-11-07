import {useEffect,useSyncExternalStore} from 'react';
import './runtime';
export type DesktopWindowState={mode:'chat'|'pet';clickThrough:boolean;panel?:{width:number;petWidth:number}};
export interface DesktopWindowBridge {
 setPetPanel?(open:boolean):Promise<DesktopWindowState>;
 dragPetWindow?(phase:"start"|"move"|"end"):Promise<void>;
 setPetHitRegions?(regions:{x:number;y:number;width:number;height:number}[]):Promise<void>;
 getWindowState():Promise<DesktopWindowState>;
 setWindowMode(mode:'chat'|'pet'):Promise<DesktopWindowState>;
 setPetClickThrough(value:boolean):Promise<DesktopWindowState>;
 onWindowStateChanged(listener:(state:DesktopWindowState)=>void):()=>void;
}
const normal:DesktopWindowState={mode:'chat',clickThrough:false};
let state=normal;
let revision=0;
const listeners=new Set<()=>void>();
const publish=(value:DesktopWindowState)=>{revision++;state=value;listeners.forEach(fn=>fn());};
const subscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export const desktopWindowAvailable=()=>!!window.momoDesktop?.setWindowMode;
export function useDesktopWindow(){return useSyncExternalStore(subscribe,()=>state);}
/** One bridge subscription at the app root; no new renderer or conversation. */
export function useDesktopWindowBridge(){
 useEffect(()=>{
  const bridge=window.momoDesktop;if(!bridge?.getWindowState||!bridge.onWindowStateChanged)return;
  let live=true;
  const unsubscribe=bridge.onWindowStateChanged(value=>{if(live)publish(value);});
  const own=revision;void bridge.getWindowState().then(value=>{if(live&&own===revision)publish(value);}).catch(()=>{});
  return()=>{live=false;unsubscribe();};
 },[]);
 const current=useDesktopWindow();
 useEffect(()=>{
  const bridge=window.momoDesktop;
  if(current.mode!=='pet'||!current.clickThrough||!bridge?.setPetHitRegions)return;
  const report=()=>{
   const regions=Array.from(document.querySelectorAll<HTMLElement>('[data-pet-interactive], .desktop-pet .dialog-box, .tooltip-bubble, .modal-overlay, .meeting-gate'))
    .filter(el=>el.checkVisibility({visibilityProperty:true,opacityProperty:true})&&!(el.matches('.dialog-box')&&el.closest('.pet-dialog-collapsed')))
    .map(el=>{
     const rect=el.getBoundingClientRect(), w=innerWidth,h=innerHeight;
     const x=Math.max(0,rect.left-8)/w,y=Math.max(0,rect.top-8)/h;
     return {x,y,width:Math.max(0,Math.min(w,rect.right+8)/w-x),height:Math.max(0,Math.min(h,rect.bottom+8)/h-y)};
    }).filter(r=>r.width>0&&r.height>0).slice(0,64);
   void bridge.setPetHitRegions!(regions).catch(()=>{});
  };
  report();
  // A renewable lease also recovers mouse input if the renderer stops responding.
  const timer=setInterval(report,100);
  window.addEventListener('resize',report);
  return()=>{clearInterval(timer);window.removeEventListener('resize',report);void bridge.setPetHitRegions!([]).catch(()=>{});};
 },[current.mode,current.clickThrough]);
 return current;
}
export async function setDesktopMode(mode:'chat'|'pet'){
 const bridge=window.momoDesktop;if(!bridge?.setWindowMode)throw new Error('Desktop window unavailable');
 const own=revision;const result=await bridge.setWindowMode(mode);if(own===revision)publish(result);
}
export async function setDesktopClickThrough(value:boolean){
 const bridge=window.momoDesktop;if(!bridge?.setPetClickThrough || (value&&!bridge.setPetHitRegions))throw new Error('Desktop window unavailable');
 const own=revision;const result=await bridge.setPetClickThrough(value);if(own===revision)publish(result);
}

export async function setDesktopPanel(open:boolean){
 const bridge=window.momoDesktop;if(!bridge?.setPetPanel)return;
 const own=revision;const result=await bridge.setPetPanel(open);if(own===revision)publish(result);
}
