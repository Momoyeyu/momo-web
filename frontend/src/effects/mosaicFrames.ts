import {mosaicFrame,type RGB} from './digitalMosaic';
export interface MosaicFrame {field:string;tint:string}
/** Only small control textures cross the worker boundary. No DOM/content pixels. */
export function prepareMosaicFrames(width:number,height:number,palette:RGB[]){
 const urls:string[]=[],images:HTMLImageElement[]=[];
 let disposed=false,worker:Worker|undefined,cancel:()=>void=()=>{};
 const seed=Math.floor(Math.random()*4294967296);
 const ready=new Promise<MosaicFrame[]>((resolve,reject)=>{
  cancel=()=>reject(new Error('Mosaic preparation cancelled'));
  const publish=async(frames:{field:Blob|string;tint:Blob|string}[])=>{
   const prepared:MosaicFrame[]=[];
   try{
    for(const frame of frames){
     if(disposed)return;
     const decode=async(value:Blob|string)=>{
      const url=typeof value==='string'?value:URL.createObjectURL(value);urls.push(url);
      const image=new Image();image.src=url;images.push(image);await image.decode();return url;
     };
     const [field,tint]=await Promise.all([decode(frame.field),decode(frame.tint)]);prepared.push({field,tint});
    }
    if(!disposed)resolve(prepared);
   }catch(error){reject(error);}
  };
  const fallback=async()=>{
   // Older engines: yield between control frames, never encode on the playback RAF.
   try{
    const canvas=document.createElement('canvas');canvas.width=Math.min(96,Math.max(1,Math.round(width)));canvas.height=Math.min(256,Math.max(1,Math.round(canvas.width*height/width)));
    const ctx=canvas.getContext('2d')!,map=ctx.createImageData(canvas.width,canvas.height),color=ctx.createImageData(canvas.width,canvas.height),frames=[];
    for(let i=0;i<=28;i++){
     if(disposed)return;
     mosaicFrame(canvas.width,canvas.height,width,height,i/28,seed,palette,{map:map.data,color:color.data});
     ctx.putImageData(map,0,0);const field=canvas.toDataURL();ctx.putImageData(color,0,0);frames.push({field,tint:canvas.toDataURL()});
     await new Promise(r=>setTimeout(r,0));
    }
    await publish(frames);
   }catch(error){reject(error);}
  };
  try{
   if(typeof OffscreenCanvas==='undefined'){void fallback();return;}
   worker=new Worker(new URL('./mosaicFrames.worker.ts',import.meta.url),{type:'module'});
   worker.onmessage=event=>{worker?.terminate();if(event.data.error)void fallback();else void publish(event.data.frames);};
   worker.onerror=()=>{worker?.terminate();void fallback();};
   worker.postMessage({width,height,palette,seed});
  }catch{void fallback();}
 });
 // Prewarming can be cancelled before a consumer attaches.
 void ready.catch(()=>{});
 return {ready,dispose(){disposed=true;worker?.terminate();cancel();for(const url of urls)if(url.startsWith('blob:'))URL.revokeObjectURL(url);images.length=0;}};
}
