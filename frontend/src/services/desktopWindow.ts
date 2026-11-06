import {useEffect,useSyncExternalStore} from 'react';
import './runtime';
export type DesktopWindowState={mode:'chat'|'pet';clickThrough:boolean};
export interface DesktopWindowBridge {
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
 return useDesktopWindow();
}
export async function setDesktopMode(mode:'chat'|'pet'){
 const bridge=window.momoDesktop;if(!bridge?.setWindowMode)throw new Error('Desktop window unavailable');
 const own=revision;const result=await bridge.setWindowMode(mode);if(own===revision)publish(result);
}
export async function setDesktopClickThrough(value:boolean){
 const bridge=window.momoDesktop;if(!bridge?.setPetClickThrough)throw new Error('Desktop window unavailable');
 const own=revision;const result=await bridge.setPetClickThrough(value);if(own===revision)publish(result);
}
