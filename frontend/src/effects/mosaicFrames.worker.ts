import {mosaicFrame,type RGB} from './digitalMosaic';
self.onmessage=async(event:MessageEvent<{width:number;height:number;seed:number;palette:RGB[]}>)=>{
 try{
  const {width,height,seed,palette}=event.data;
  const w=Math.max(1,Math.min(96,Math.round(width))),h=Math.max(1,Math.min(256,Math.round(w*height/width)));
  const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d')!;
  const map=ctx.createImageData(w,h),color=ctx.createImageData(w,h),frames=[];
  for(let i=0;i<=28;i++){
   mosaicFrame(w,h,width,height,i/28,seed,palette,{map:map.data,color:color.data});
   ctx.putImageData(map,0,0);const field=await canvas.convertToBlob();
   ctx.putImageData(color,0,0);const tint=await canvas.convertToBlob();
   frames.push({field,tint});
  }
  self.postMessage({frames});
 }catch{self.postMessage({error:true});}
};
