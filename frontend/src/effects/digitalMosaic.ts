/** A field describing how to reconstruct the actual SourceGraphic.
 * RG = sampling displacement, B = coverage. A second texture carries transient
 * palette errors. Neither texture is a screenshot or a copy of the content.
 */
export const MOSAIC_SCALE = 96;
export type RGB = readonly [number, number, number];
const clamp = (v:number) => Math.max(0,Math.min(1,v));
function random(x:number,y:number,seed:number) {
 let n=Math.imul(x+1,374761393)^Math.imul(y+1,668265263)^seed;
 n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967296;
}
export function mosaicFrame(width:number,height:number,physicalWidth:number,physicalHeight:number,progress:number,seed:number,palette:readonly RGB[],buffers?:{map:Uint8ClampedArray<ArrayBuffer>;color:Uint8ClampedArray<ArrayBuffer>}) {
 const map=buffers?.map??new Uint8ClampedArray(width*height*4),color=buffers?.color??new Uint8ClampedArray(map.length);
 const p=clamp(progress),cell=20,sx=physicalWidth/width,sy=physicalHeight/height;
 // Compute phase, noise and lighting once per cell, not once per control pixel.
 for(let cy=0;cy<Math.ceil(physicalHeight/cell);cy++)for(let cx=0;cx<Math.ceil(physicalWidth/cell);cx++){
  const noise=random(cx,cy,seed),cluster=random(Math.floor(cx/3),Math.floor(cy/3),seed+17);
  const local=clamp((p-(noise*.8+cluster*.2)*.54)/.46);
  const turn=local*3,phase=turn-Math.floor(turn),tick=Math.floor(turn);
  const unsettled=clamp((.94-local)/.2);
  const face=1-unsettled*(1-Math.abs(Math.cos(Math.PI*phase)));
  const vertical=random(cx,cy,seed+7)>.5;
  const grain=local>=.94?1:local>.75?2:local>.53?5:local>.28?10:20;
  const jx=(random(cx,cy,seed+tick*101)-.5)*(1-local)*18;
  const jy=(random(cx,cy,seed+tick*211)-.5)*(1-local)*18;
  const a=palette[Math.floor(random(cx,cy,seed+tick*37)*palette.length)];
  const b=palette[Math.floor(random(cx,cy,seed+(tick+1)*37)*palette.length)];
  const blend=(1-Math.cos(phase*Math.PI))/2;
  const base=a.map((v,i)=>v*(1-blend)+b[i]*blend);
  for(let y=Math.max(0,Math.ceil(cy*cell/sy-.5));y<Math.min(height,Math.ceil((cy+1)*cell/sy-.5));y++)for(let x=Math.max(0,Math.ceil(cx*cell/sx-.5));x<Math.min(width,Math.ceil((cx+1)*cell/sx-.5));x++){
   const px=(x+.5)*sx,py=(y+.5)*sy,u=(px-cx*cell)/cell-.5,v=(py-cy*cell)/cell-.5;
   const axis=vertical?v:u;
   const cover=local>=.94?1:clamp((face/2-Math.abs(axis))*32+.5);
   const rx=vertical?px:(cx+.5+u/Math.max(.08,face))*cell;
   const ry=vertical?(cy+.5+v/Math.max(.08,face))*cell:py;
   const dx=local>=.94?0:Math.floor(rx/grain)*grain+grain/2-px+jx;
   const dy=local>=.94?0:Math.floor(ry/grain)*grain+grain/2-py+jy;
   const i=(y*width+x)*4;
   map[i]=Math.round((.5+dx/MOSAIC_SCALE)*255);map[i+1]=Math.round((.5+dy/MOSAIC_SCALE)*255);
   map[i+2]=Math.round(clamp(local/.07)*cover*255);map[i+3]=255;
   // A beveled glass face: opposing edge reflections and a moving specular band.
   const bevel=clamp((Math.max(Math.abs(u),Math.abs(v))-.37)/.13);
   const spec=Math.pow(Math.max(0,1-Math.abs(u+v*.45-(phase-.5)*1.8)*5),3);
   const light=clamp((bevel*.3+spec*.65)*unsettled);
   for(let c=0;c<3;c++)color[i+c]=base[c]*(1-light)+palette[2][c]*light;
   color[i+3]=Math.round((local>0&&local<.94?((1-local)*.42+light*.48):0)*255);
  }
 }
 return {map,color};
}
