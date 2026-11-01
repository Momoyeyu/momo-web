import {useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import './blurPresence.css';
import {phoneGridReveal} from '../lib/gridReveal';

/** One CSS transition clock, shared with the caller's scene movement. */
export default function BlurPresence({visible,initialVisible=false,animate=true,onTargetChange,children}:{visible:boolean;initialVisible?:boolean;animate?:boolean;onTargetChange?:(visible:boolean)=>void;children:ReactNode}){
 const id=`phone-grid-${useId().replace(/[^a-zA-Z0-9_-]/g,'')}`;
 const clip=useRef<SVGClipPathElement>(null);
 const root=useRef<HTMLDivElement>(null),source=useRef<HTMLDivElement>(null),initial=useRef(initialVisible).current;
 const callback=useRef(onTargetChange);callback.current=onTargetChange;
 useLayoutEffect(()=>{
  const el=source.current,host=root.current;if(!el||!host)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');let cancelled=false,raf=0,observer:ResizeObserver|undefined;
  const cell=18,cells:{rect:SVGRectElement;row:number;rows:number;width:number;height:number}[]=[];
  const paint=(progress:number)=>{
   for(const tile of cells){const p=phoneGridReveal(tile.row,tile.rows,progress);tile.rect.setAttribute('width',String(tile.width*p));tile.rect.setAttribute('height',String(tile.height*p));}
   host.dataset.gridProgress=String(progress);
  };
  const geometry=()=>{
   const w=el.clientWidth,h=el.clientHeight;if(!w||!h||!clip.current)return;
   const cols=Math.ceil(w/cell),rows=Math.ceil(h/cell);cells.length=0;clip.current.replaceChildren();
   const fragment=document.createDocumentFragment();
   for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('x',String(col*cell/w));rect.setAttribute('y',String(row*cell/h));
    cells.push({rect,row,rows,width:cell/w,height:cell/h});fragment.appendChild(rect);
   }
   clip.current.appendChild(fragment);paint(Number(getComputedStyle(el).opacity));
  };
  const finish=()=>{
   if(cancelled)return;
   cancelAnimationFrame(raf);observer?.disconnect();el.style.clipPath='none';
   el.style.visibility=visible?'visible':'hidden';el.style.willChange='auto';host.dataset.phase=visible?'visible':'hidden';
  };
  const target=()=>{el.style.opacity=visible?'1':'0';el.style.filter=visible?'blur(0px)':'blur(12px)';};
  const instant=()=>{el.style.transition='none';target();finish();};
  // Inform the scene on both edges, so blur and avatar movement start together.
  callback.current?.(visible);
  if(!animate||media.matches){instant();return;}
  const current=getComputedStyle(el);
  if(Number(current.opacity)===(visible?1:0)&&current.filter===(visible?'blur(0px)':'blur(12px)')){target();finish();return;}
  el.style.transition='opacity var(--phone-motion-duration,350ms) var(--phone-motion-ease,ease), filter var(--phone-motion-duration,350ms) var(--phone-motion-ease,ease)';
  geometry();el.style.clipPath=`url(#${id})`;
  el.style.visibility='visible';el.style.willChange='filter, opacity';
  // Establish the current style before the target, including rapid reversals.
  void getComputedStyle(el).opacity;target();
  host.dataset.phase=visible?'appearing':'disappearing';
  // Read the CSS opacity clock shared with avatar movement; no second timer.
  const tick=()=>{if(cancelled)return;paint(Number(getComputedStyle(el).opacity));raf=requestAnimationFrame(tick);};tick();
  observer=new ResizeObserver(geometry);observer.observe(el);
  void Promise.allSettled(el.getAnimations().map(a=>a.finished)).then(finish);
  const reduce=()=>{if(media.matches)instant();};media.addEventListener('change',reduce);
  return()=>{cancelled=true;cancelAnimationFrame(raf);observer?.disconnect();media.removeEventListener('change',reduce);};
 },[visible,animate,id]);
 return <div className="blur-presence" ref={root}><svg className="phone-grid-defs" width="0" height="0" aria-hidden="true"><defs><clipPath id={id} ref={clip} clipPathUnits="objectBoundingBox"/></defs></svg><div ref={source} className="blur-presence-source" style={{opacity:initial?1:0,filter:initial?'blur(0px)':'blur(12px)',visibility:initial?'visible':'hidden'}}>{children}</div></div>;
}
