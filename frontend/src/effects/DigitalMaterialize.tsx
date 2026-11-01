import {useCallback,useEffect,useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import {MOSAIC_SCALE,type RGB} from './digitalMosaic';
import {prepareMosaicFrames,type MosaicFrame} from './mosaicFrames';
import './digitalMaterialize.css';

/** Reusable DOM materialization: one live content tree, sampled by an SVG filter.
 * No clones, screenshots, remote assets or per-frame React updates.
 * Reverse in flight uses the same field and current progress, without flashing.
 */
export default function DigitalMaterialize({visible,children,duration=440,onPresenceChange,initialVisible=false,animate=true,beforeEnter}:{visible:boolean;children:ReactNode;duration?:number;onPresenceChange?:(present:boolean)=>void;initialVisible?:boolean;animate?:boolean;beforeEnter?:()=>Promise<void>}){
 const id=`materialize-${useId().replace(/[^a-zA-Z0-9_-]/g,'')}`;
 const host=useRef<HTMLDivElement>(null),source=useRef<HTMLDivElement>(null);
 const field=useRef<SVGFEImageElement>(null),tint=useRef<SVGFEImageElement>(null);
 const presence=useRef(onPresenceChange);presence.current=onPresenceChange;
 const enterGate=useRef(beforeEnter);enterGate.current=beforeEnter;
 const progress=useRef(initialVisible?1:0);
 const cache=useRef<{key:string;frames?:MosaicFrame[];job:ReturnType<typeof prepareMosaicFrames>}|null>(null);
 const prepare=useCallback(()=>{
  const root=host.current,el=source.current;if(!root||!el||!el.clientWidth||!el.clientHeight)return null;
  const style=getComputedStyle(root),palette:RGB[]=[];
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');if(!ctx)return null;
  for(const name of ['--panel-solid','--accent','--text','--text-dim']){
   ctx.fillStyle=style.getPropertyValue(name).trim()||'#282330';ctx.fillRect(0,0,1,1);
   const c=ctx.getImageData(0,0,1,1).data;palette.push([c[0],c[1],c[2]]);
  }
  const key=JSON.stringify([el.clientWidth,el.clientHeight,palette]);
  if(cache.current?.key===key)return cache.current;
  if(cache.current&&['appearing','disappearing','preparing'].includes(root.dataset.phase??''))return cache.current;
  cache.current?.job.dispose();root.dataset.ready='false';
  const own={key,job:prepareMosaicFrames(el.clientWidth,el.clientHeight,palette),frames:undefined as MosaicFrame[]|undefined};cache.current=own;
  void own.job.ready.then(frames=>{if(cache.current===own){own.frames=frames;root.dataset.ready='true';}}).catch(()=>{});
  return own;
 },[]);
 useEffect(()=>{
  const el=source.current;if(!el)return;
  // Hidden content still has layout, so prewarm as soon as the chat stage is ready.
  const observer=new ResizeObserver(()=>{if(animate)prepare();});observer.observe(el);
  if(animate)prepare();return()=>observer.disconnect();
 },[animate,prepare]);
 useEffect(()=>()=>{cache.current?.job.dispose();cache.current=null;},[]);
 useLayoutEffect(()=>{
  const el=source.current,root=host.current;if(!el||!root)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let frame=0,disposed=false;
  const finish=()=>{
   progress.current=visible?1:0;
   el.style.filter='none';el.style.visibility=visible?'visible':'hidden';
   root.dataset.phase=visible?'visible':'hidden';presence.current?.(visible);
   field.current?.removeAttribute('href');tint.current?.removeAttribute('href');
   if(animate&&!media.matches)prepare();
  };
  if(!animate||media.matches||progress.current===(visible?1:0)){finish();return;}
  const own=prepare();if(!own){finish();return;}
  const play=(frames:MosaicFrame[])=>{
   if(disposed)return;
   if(media.matches){finish();return;}
   root.dataset.phase=visible?'appearing':'disappearing';
   const start=performance.now(),from=progress.current,target=visible?1:0,total=Math.max(1,duration*Math.abs(target-from));
   let previous=-1;
   const draw=(now:number)=>{
    if(disposed)return;
    const fraction=Math.min(1,(now-start)/total);progress.current=from+(target-from)*fraction;
    if(fraction>=1){finish();return;}
    const index=Math.round(progress.current*(frames.length-1));
    if(index!==previous){previous=index;field.current?.setAttribute('href',frames[index].field);tint.current?.setAttribute('href',frames[index].tint);}
    el.style.filter=`url(#${id})`;el.style.visibility='visible';
    frame=requestAnimationFrame(draw);
   };draw(start);
  };
  const gate=visible&&enterGate.current;
  if(visible)presence.current?.(true);
  if(own.frames&&!gate)play(own.frames);
  else{root.dataset.phase='preparing';const stage=gate?gate():Promise.resolve();void Promise.all([own.job.ready,stage]).then(([frames])=>play(frames)).catch(()=>{if(!disposed)finish();});}
  const reduced=()=>{if(media.matches){cancelAnimationFrame(frame);finish();}};media.addEventListener('change',reduced);
  return()=>{disposed=true;cancelAnimationFrame(frame);media.removeEventListener('change',reduced);};
 },[visible,duration,id,animate,prepare]);
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
