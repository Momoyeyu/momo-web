import {useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import {mosaicFrame,MOSAIC_SCALE,type RGB} from './digitalMosaic';
import './digitalMaterialize.css';

/** Reusable DOM materialization: one live content tree, sampled by an SVG filter.
 * No clones, screenshots, remote assets or per-frame React updates.
 * Reverse in flight uses the same field and current progress, without flashing.
 */
export default function DigitalMaterialize({visible,children,duration=440,onPresenceChange,initialVisible=false,animate=true}:{visible:boolean;children:ReactNode;duration?:number;onPresenceChange?:(present:boolean)=>void;initialVisible?:boolean;animate?:boolean}){
 const id=`materialize-${useId().replace(/[^a-zA-Z0-9_-]/g,'')}`;
 const host=useRef<HTMLDivElement>(null),source=useRef<HTMLDivElement>(null);
 const field=useRef<SVGFEImageElement>(null),tint=useRef<SVGFEImageElement>(null);
 const presence=useRef(onPresenceChange);presence.current=onPresenceChange;
 const progress=useRef(initialVisible?1:0),seed=useRef(0),running=useRef(false);
 useLayoutEffect(()=>{
  const el=source.current,root=host.current;if(!el||!root)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0,disposed=false;
  const finish=()=>{
   progress.current=visible?1:0;running.current=false;
   el.style.filter='none';el.style.visibility=visible?'visible':'hidden';
   root.dataset.phase=visible?'visible':'hidden';
   presence.current?.(visible);
   field.current?.removeAttribute('href');tint.current?.removeAttribute('href');
  };
  if(!animate||media.matches||progress.current===(visible?1:0)){finish();return;}
  if(!running.current)seed.current=Math.floor(Math.random()*4294967296);
  running.current=true;root.dataset.phase=visible?'appearing':'disappearing';
  if(visible)presence.current?.(true);
  const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
  if(!ctx){finish();return;}
  const style=getComputedStyle(root),palette:RGB[]=[];
  canvas.width=canvas.height=1;
  for(const name of ['--panel-solid','--accent','--text','--text-dim']){
   ctx.fillStyle=style.getPropertyValue(name).trim()||'#282330';ctx.fillRect(0,0,1,1);
   const c=ctx.getImageData(0,0,1,1).data;palette.push([c[0],c[1],c[2]]);
  }
  let mapImage:ImageData,colorImage:ImageData;
  const start=performance.now(),from=progress.current,target=visible?1:0;
  const total=Math.max(1,duration*Math.abs(target-from));
  const draw=(now:number)=>{
   if(disposed)return;
   const fraction=Math.min(1,(now-start)/total);progress.current=from+(target-from)*fraction;
   if(fraction>=1){finish();return;}
   // Follow RAF: small reusable control buffers instead of 30Hz quantization.
   {
    const w=el.clientWidth,h=el.clientHeight;
    if(w&&h){
     const width=Math.max(1,Math.min(96,Math.round(w))),height=Math.max(1,Math.min(256,Math.round(width*h/w)));
     if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;mapImage=ctx.createImageData(width,height);colorImage=ctx.createImageData(width,height);}
     mosaicFrame(width,height,w,h,progress.current,seed.current,palette,{map:mapImage.data,color:colorImage.data});
     ctx.putImageData(mapImage,0,0);
     field.current?.setAttribute('href',canvas.toDataURL());
     ctx.putImageData(colorImage,0,0);
     tint.current?.setAttribute('href',canvas.toDataURL());
     el.style.filter=`url(#${id})`;el.style.visibility='visible';
    }
   }
   frame=requestAnimationFrame(draw);
  };
  draw(start);
  const reduced=()=>{if(media.matches){cancelAnimationFrame(frame);finish();}};
  media.addEventListener('change',reduced);
  return()=>{disposed=true;cancelAnimationFrame(frame);media.removeEventListener('change',reduced);};
 },[visible,duration,id,animate]);
 return <div className="digital-materialize" ref={host}>
  <svg className="digital-materialize-defs" aria-hidden="true" width="0" height="0"><defs>
   <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
    <feImage ref={field} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="field"/>
    <feDisplacementMap in="SourceGraphic" in2="field" scale={MOSAIC_SCALE} xChannelSelector="R" yChannelSelector="G" result="sampled"/>
    <feImage ref={tint} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="tint"/>
    <feComposite in="tint" in2="sampled" operator="over" result="colored"/>
    <feColorMatrix in="field" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 0" result="coverage"/>
    <feComposite in="colored" in2="coverage" operator="in" result="resolved"/>
    <feComposite in="resolved" in2="SourceAlpha" operator="in"/>
   </filter>
  </defs></svg>
  <div className="digital-materialize-source" ref={source} style={{visibility:'hidden'}}>{children}</div>
 </div>;
}
