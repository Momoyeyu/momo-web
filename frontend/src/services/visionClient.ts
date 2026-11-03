import {runtimeFetch} from './runtime';
import {apiJson} from './http';
import type {ImageRef,LlmConfig} from '../lib/types';
export interface VisionStatus {verified:boolean;enabled:boolean;fingerprint:string}
export function visionStatus(cfg:LlmConfig,signal?:AbortSignal):Promise<Pick<VisionStatus,'verified'>>{return apiJson('/api/vision/capability',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(cfg),signal});}
export async function probeVision(cfg:LlmConfig,signal?:AbortSignal):Promise<{ok:boolean;detail:string}>{
 return apiJson('/api/vision/probe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(cfg),signal});
}
export async function uploadImage(file:File,signal:AbortSignal):Promise<ImageRef>{
 const body=new FormData();body.append('file',file);
 const response=await runtimeFetch('/api/vision/images',{method:'POST',body,signal});
 if(!response.ok){let key='vision.uploadFailed';try{const data=await response.json();if(typeof data.detail==='string'&&data.detail.startsWith('vision.'))key=data.detail;}catch{/* bounded error */}throw new Error(key);}
 return response.json();
}
export function deleteImage(id:string,forget=false):Promise<void>{return runtimeFetch('/api/vision/images/'+id+(forget?'?forget=true':''),{method:'DELETE'}).then(response=>{if(!response.ok)throw new Error('vision.unavailable');window.dispatchEvent(new CustomEvent('momo:image-deleted',{detail:id}));});}
