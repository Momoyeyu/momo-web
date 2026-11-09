import {useEffect,useSyncExternalStore} from 'react';
import {apiJson,jsonInit} from './http';
export type ActivityId='computer'|'browser'|'minecraft';
let enabled:Record<ActivityId,boolean>={computer:false,browser:false,minecraft:false};
let supported:Record<ActivityId,boolean>={computer:true,browser:true,minecraft:true};
export const activitySupported=(id:ActivityId)=>supported[id];
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const snapshot=()=>enabled;
export async function refreshActivities(){const value=await apiJson<{enabled:typeof enabled;supported?:typeof supported}>('/api/extensions/activities');enabled=value.enabled;supported=value.supported??{computer:true,browser:true,minecraft:true};listeners.forEach(fn=>fn());}
export async function setActivityEnabled(id:ActivityId,value:boolean){try{await apiJson('/api/extensions/activities',jsonInit('PATCH',{id,enabled:value}));}finally{await refreshActivities();}}
export function useActivities(){const value=useSyncExternalStore(subscribe,snapshot);useEffect(()=>{void refreshActivities().catch(()=>{});},[]);return value;}
