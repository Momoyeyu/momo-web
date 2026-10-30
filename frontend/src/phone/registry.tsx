import type {ReactNode} from 'react';
import type {PhoneSnapshot,PhoneMessage} from '../services/phoneClient';
export interface PhoneViewProps {data:PhoneSnapshot|null;peer?:string;setPeer:(peer:string|undefined)=>void;setApp:(app:string|null)=>void;choosePeer:(peer:string)=>void;messages:PhoneMessage[];loading:boolean;cursor:number|null|undefined;earlier:()=>Promise<void>}
export interface PhoneApp {id:string;source:string;icon:ReactNode;render?:(props:PhoneViewProps)=>ReactNode}
const apps=new Map<string,PhoneApp>();let revision=0;
const listeners=new Set<()=>void>();
export const phoneApps=()=>[...apps.values()];
export const phoneRevision=()=>revision;
export function subscribePhoneApps(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}
export function registerPhoneApp(app:PhoneApp){
 if(apps.has(app.id))throw Error('Duplicate phone app');apps.set(app.id,app);revision++;listeners.forEach(fn=>fn());
 return()=>{if(apps.get(app.id)===app){apps.delete(app.id);revision++;listeners.forEach(fn=>fn());}};
}
