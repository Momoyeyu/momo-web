import {apiJson,apiFetch,jsonInit} from './http';
import {meetingIdentity,subscribeMeeting,meetingSnapshot} from './meetingClient';
export type ComputerStatus={observing:boolean;generation:number;source:string;proactive:boolean;reactions:boolean;reason:string;executionAvailable:boolean;desktopAllowed?:boolean;desktopError?:string};
export type ComputerView={status:ComputerStatus|null;busy:boolean;error:boolean;text:string};
let view:ComputerView={status:null,busy:false,error:false,text:''};
let stream:MediaStream|null=null,video:HTMLVideoElement|null=null,timer:ReturnType<typeof setTimeout>|undefined,epoch=0;
let pendingStart:Promise<ComputerStatus>|null=null,stopping:Promise<void>|null=null;
const listeners=new Set<()=>void>();
function publish(patch:Partial<ComputerView>){view={...view,...patch};listeners.forEach(fn=>fn());}
export const computerSnapshot=()=>view;
export const subscribeComputer=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export async function readComputer(){publish({status:await apiJson<ComputerStatus>('/api/computer/status')});}
export function stopComputer():Promise<void>{
 if(stopping)return stopping;
 epoch++;clearTimeout(timer);const old=stream;stream=null;video=null;old?.getTracks().forEach(track=>track.stop());
 publish({busy:true,text:'',status:view.status?{...view.status,observing:false}:null});
 stopping=(async()=>{
  try{await pendingStart?.catch(()=>{});publish({status:await apiJson<ComputerStatus>('/api/computer/stop',{method:'POST'})});}catch{publish({error:true});}
  finally{stopping=null;publish({busy:false});}
 })();return stopping;
}
subscribeMeeting(()=>{if(stream&&(!meetingIdentity()||meetingSnapshot().attention.focus))void stopComputer();});
export async function configureComputer(proactive:boolean,reactions:boolean){publish({status:await apiJson<ComputerStatus>('/api/computer/settings',jsonInit('PATCH',{proactive,reactions}))});}
export async function startComputer(){
 if(view.busy||stream)return;publish({busy:true,error:false,text:''});const own=++epoch;
 try{
  if(!meetingIdentity())throw new Error('Boot required');
  const media=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
  if(own!==epoch){media.getTracks().forEach(track=>track.stop());return;}
  stream=media;const track=media.getVideoTracks()[0]!;track.onended=()=>void stopComputer();
  const player=document.createElement('video');player.muted=true;player.srcObject=media;await player.play();if(own!==epoch)return;video=player;
  pendingStart=apiJson<ComputerStatus>('/api/computer/start',jsonInit('POST',{source:track.label.slice(0,200)||'Shared screen',proactive:view.status?.proactive??false,reactions:view.status?.reactions??false}));
  const status=await pendingStart.finally(()=>{pendingStart=null;});
  if(own!==epoch)return;publish({status,busy:false});
  let lastReaction=0;
  const capture=async()=>{
   if(own!==epoch||!video||!stream)return;
   try{
    const identity=meetingIdentity();if(!identity){await stopComputer();return;}
    if(document.visibilityState!=='hidden'){
     const canvas=document.createElement('canvas');const scale=Math.min(1,1280/video.videoWidth);canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));
     canvas.getContext('2d')!.drawImage(video,0,0,canvas.width,canvas.height);
     const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',.75));if(!blob)throw new Error('No frame');
     if(own!==epoch)return;const body=new FormData();body.set('generation',String(status.generation));body.set('file',blob,'frame.jpg');
     await apiFetch('/api/computer/frames',{method:'POST',body,signal:AbortSignal.timeout(10000)});
     if(view.status?.proactive&&view.status.reactions&&Date.now()-lastReaction>=30000){
      lastReaction=Date.now();
      const {getChatEngine}=await import('../chat/engineInstance');
      if(own===epoch)getChatEngine().sendScreenReaction(status.generation);
     }
    }
   }catch{if(own===epoch){await stopComputer();publish({error:true});}return;}
   if(own===epoch)timer=setTimeout(()=>void capture(),2500);
  };void capture();
 }catch{if(own===epoch){await stopComputer();publish({error:true});}}
 finally{if(own===epoch)publish({busy:false});}
}
export async function askComputer(question:string){
 const identity=meetingIdentity(),generation=view.status?.generation,own=epoch;if(!identity||generation===undefined)return;
 publish({busy:true,error:false});try{const result=await apiJson<{text:string}>('/api/computer/ask',jsonInit('POST',{...identity,generation,question}));if(own===epoch)publish({text:result.text});}catch{if(own===epoch)publish({error:true});}finally{if(own===epoch)publish({busy:false});}
}
export async function setDesktopObservation(enabled:boolean){
 const identity=meetingIdentity();if(!identity)return;
 publish({busy:true,error:false});
 try{publish({status:await apiJson<ComputerStatus>('/api/computer/desktop/observation',jsonInit('POST',{...identity,enabled}))});}
 catch{publish({error:true});}finally{publish({busy:false});}
}
export async function captureDesktop(){
 const identity=meetingIdentity();if(!identity||meetingSnapshot().attention.focus)return;
 try{publish({status:await apiJson<ComputerStatus>('/api/computer/desktop/frame',jsonInit('POST',identity)),error:false});}
 catch{await readComputer().catch(()=>{});publish({error:true});}
}
