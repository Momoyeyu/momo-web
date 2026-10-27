import {runtimeFetch} from './runtime';

const STATES=['idle','preparing','connecting','qr_pending','awaiting_confirmation','verifying','connected','expired','cancelled','disconnected','identity_mismatch','stopping','stopped','error'] as const;
const ERROR_CODES=['OWNER_ACTION_REQUIRED','RESOURCE_UNAVAILABLE','RESOURCE_INVALID','INPUT','ATTEMPT_CANCELLED','RUNTIME_FAILED','RUNTIME_UNAVAILABLE','RUNTIME_TIMEOUT','RUNTIME_NOT_QUIESCENT','RUNTIME_STOPPED','IPC_LIMIT','IPC_PROTOCOL','ACCOUNT_MISMATCH','FORGET_UNAVAILABLE','FORGET_FAILED'] as const;
const ACTIONS=['begin','refresh','cancel','stop','forget'] as const;
export type QQRuntimeAction=(typeof ACTIONS)[number];
export type QQLoginErrorCode=(typeof ERROR_CODES)[number];
export interface QQRuntimeState {
  provider:'qq';status:(typeof STATES)[number];running:boolean;connected:boolean;
  actualSelfId:string|null;attemptId:string|null;error:QQLoginErrorCode|null;
  executorQuiescent:boolean;qr:{dataUrl:string;expiresAt:number}|null;
}
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const codeOf=(value:unknown):QQLoginErrorCode=>ERROR_CODES.includes(value as QQLoginErrorCode)?value as QQLoginErrorCode:'RUNTIME_FAILED';
export class QQLoginError extends Error {
  readonly code:QQLoginErrorCode;
  constructor(code:unknown){const safe=codeOf(code);super(safe);this.name='QQLoginError';this.code=safe;}
}
export function parseQQRuntime(value:unknown):QQRuntimeState {
  const invalid=()=>{throw new QQLoginError('IPC_PROTOCOL');};
  if(!object(value)||value.provider!=='qq'||!STATES.includes(value.status as QQRuntimeState['status'])||typeof value.running!=='boolean'||typeof value.connected!=='boolean'||typeof value.executorQuiescent!=='boolean')return invalid();
  if(value.actualSelfId!==null&&(typeof value.actualSelfId!=='string'||! /^[1-9]\d{0,19}$/.test(value.actualSelfId)))return invalid();
  if(value.attemptId!==null&&(typeof value.attemptId!=='string'||value.attemptId.length===0||value.attemptId.length>128))return invalid();
  if(value.connected!==(value.status==='connected')||(value.connected&&(!value.actualSelfId||!value.running))||(value.running&&value.executorQuiescent))return invalid();
  let qr:QQRuntimeState['qr']=null;
  if(value.qr!==null&&value.qr!==undefined){
    const image=value.qr;
    if(!object(image)||!value.attemptId||!['qr_pending','awaiting_confirmation','verifying'].includes(String(value.status))||typeof image.dataUrl!=='string'||image.dataUrl.length>384*1024||!/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(image.dataUrl)||!Number.isSafeInteger(image.expiresAt)||(image.expiresAt as number)>Date.now()+10*60*1000)return invalid();
    qr={dataUrl:image.dataUrl,expiresAt:image.expiresAt as number};
  }
  return{provider:'qq',status:value.status as QQRuntimeState['status'],running:value.running,connected:value.connected,actualSelfId:value.actualSelfId as string|null,attemptId:value.attemptId as string|null,error:value.error==null?null:codeOf(value.error),executorQuiescent:value.executorQuiescent,qr};
}
async function request(action?:QQRuntimeAction,signal?:AbortSignal):Promise<QQRuntimeState>{
  if(action!==undefined&&!ACTIONS.includes(action))throw new QQLoginError('INPUT');
  const deadline=new AbortController();const timer=setTimeout(()=>deadline.abort(),45000);
  try{
    const response=await runtimeFetch(`/api/social/accounts/qq/runtime${action?`/${action}`:''}`,{signal:signal?AbortSignal.any([signal,deadline.signal]):deadline.signal,cache:'no-store',...(action?{method:'POST',headers:{'content-type':'application/json'},body:'{}'}:{})});
    if(!response.ok){
      let code:unknown;
      try{const body:unknown=await response.json();if(object(body))code=object(body.detail)?body.detail.code:body.code;}catch{/* Server text and private host details are never displayed. */}
      throw new QQLoginError(code);
    }
    return parseQQRuntime(await response.json());
  }catch(error){if(deadline.signal.aborted&&!signal?.aborted)throw new QQLoginError('RUNTIME_TIMEOUT');throw error;}
  finally{clearTimeout(timer);}
}
export const qqRuntimeStatus=(signal?:AbortSignal)=>request(undefined,signal);
export const qqRuntimeAction=(action:QQRuntimeAction,signal?:AbortSignal)=>request(action,signal);
export function visibleQQRuntime(state:QQRuntimeState,now=Date.now()):QQRuntimeState{
  return state.qr&&state.qr.expiresAt<=now?{...state,status:'expired',qr:null}:state;
}

/** Observation owns no login session. Disposing only fences UI work and stops polling. */
export function observeQQRuntime({read=qqRuntimeStatus,action=qqRuntimeAction,onState,onError,onBusy,intervalMs=1200}:{
  read?:(signal?:AbortSignal)=>Promise<QQRuntimeState>;action?:(action:QQRuntimeAction,signal?:AbortSignal)=>Promise<QQRuntimeState>;
  onState:(state:QQRuntimeState|null)=>void;onError:(code:QQLoginErrorCode|null)=>void;onBusy:(busy:boolean)=>void;intervalMs?:number;
}){
  let active=false;let generation=0;let timer:ReturnType<typeof setTimeout>|undefined;let request:AbortController|undefined;
  const invalidate=()=>{generation++;clearTimeout(timer);request?.abort();};
  const schedule=()=>{if(active)timer=setTimeout(()=>void poll(),intervalMs);};
  const poll=async()=>{
    if(!active)return;const own=++generation;request=new AbortController();
    try{const state=await read(request.signal);if(active&&own===generation){onState(visibleQQRuntime(state));onError(null);}}
    catch(error){if(active&&own===generation){onState(null);onError(codeOf(error instanceof QQLoginError?error.code:undefined));}}
    finally{if(active&&own===generation)schedule();}
  };
  return{
    start(){if(active)return;active=true;void poll();},
    dispose(){active=false;invalidate();},
    async act(method:QQRuntimeAction){
      if(!active)return;invalidate();const own=generation;request=new AbortController();onBusy(true);onError(null);onState(null);
      try{const state=await action(method,request.signal);if(active&&own===generation)onState(visibleQQRuntime(state));}
      catch(error){if(active&&own===generation)onError(codeOf(error instanceof QQLoginError?error.code:undefined));}
      finally{if(active&&own===generation){onBusy(false);schedule();}}
    },
  };
}
