import {useEffect,useSyncExternalStore} from 'react';
import {apiJson,jsonInit} from './http';
export type ActivityId='computer'|'browser'|'minecraft';
let enabled:Record<ActivityId,boolean>={computer:false,browser:false,minecraft:false};
const listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const snapshot=()=>enabled;
export async function refreshActivities(){const value=await apiJson<{enabled:typeof enabled}>('/api/extensions/activities');enabled=value.enabled;listeners.forEach(fn=>fn());}
export async function setActivityEnabled(id:ActivityId,value:boolean){try{await apiJson('/api/extensions/activities',jsonInit('PATCH',{id,enabled:value}));}finally{await refreshActivities();}}
export function useActivities(){const value=useSyncExternalStore(subscribe,snapshot);useEffect(()=>{void refreshActivities().catch(()=>{});},[]);return value;}
