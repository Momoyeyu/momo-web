import {useSyncExternalStore} from 'react';
import {apiJson,jsonInit} from './http';
import {getState,pausePersistence,update} from '../lib/store';
export interface IntroState {phase:'setup'|'tts'|'await_boot'|'naming'|'memory'|'return_title'|'celebration'|'completed';memoryId?:string;languageConfirmed:boolean;configurationValid:boolean;legacy?:boolean}
interface Snapshot {data:IntroState|null;failed:boolean;busy:boolean;error:boolean}
let current:Snapshot={data:null,failed:false,busy:false,error:false};
let serial=0;
const listeners=new Set<()=>void>();
const emit=(patch:Partial<Snapshot>)=>{current={...current,...patch};for(const listener of listeners)listener();};
export const introSnapshot=()=>current;
export const subscribeIntro=(fn:()=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);};
export const useIntro=()=>useSyncExternalStore(subscribeIntro,introSnapshot);
export async function refreshIntro(){const version=++serial;try{const data=await apiJson<IntroState>('/api/intro');if(version===serial)emit({data,failed:false});}catch{if(version===serial)emit({failed:true});}}
export function introRestricted(){return current.data?.phase!=='completed';}
async function action(path:string,body:unknown){
  serial++;emit({busy:true,error:false});
  try{const data=await apiJson<IntroState>(`/api/intro/${path}`,jsonInit('POST',body));emit({data,failed:false});return data;}
  catch(error){emit({error:true});throw error;}
  finally{emit({busy:false});}
}
export async function confirmIntroLanguage(){
  update({settings:{...getState().settings,general:{...getState().settings.general,chatLang:'auto'}}});
  const resume=await pausePersistence();
  try{return await action('language',{lang:getState().settings.general.lang});}finally{resume();}
}
export async function verifyIntro(){
  const resume=await pausePersistence();
  try{return await action('verify',{...getState().settings.llm});}finally{resume();}
}
export const finishIntro=()=>action('finish',{});

export const completeIntroTts=()=>action('tts',{});
export const confirmIntroMemory=()=>action('memory',{});
export const acknowledgeIntro=()=>action('acknowledge',{});
