import {useLayoutEffect,useRef,type ReactNode} from 'react';
import './blurPresence.css';

/** One CSS transition clock, shared with the caller's scene movement. */
export default function BlurPresence({visible,initialVisible=false,animate=true,onTargetChange,children}:{visible:boolean;initialVisible?:boolean;animate?:boolean;onTargetChange?:(visible:boolean)=>void;children:ReactNode}){
 const root=useRef<HTMLDivElement>(null),source=useRef<HTMLDivElement>(null),initial=useRef(initialVisible).current;
 const callback=useRef(onTargetChange);callback.current=onTargetChange;
 useLayoutEffect(()=>{
  const el=source.current,host=root.current;if(!el||!host)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');let cancelled=false;
  const finish=()=>{
   if(cancelled)return;
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
  el.style.visibility='visible';el.style.willChange='filter, opacity';
  // Establish the current style before the target, including rapid reversals.
  void getComputedStyle(el).opacity;target();
  host.dataset.phase=visible?'appearing':'disappearing';
  void Promise.allSettled(el.getAnimations().map(a=>a.finished)).then(finish);
  const reduce=()=>{if(media.matches)instant();};media.addEventListener('change',reduce);
  return()=>{cancelled=true;media.removeEventListener('change',reduce);};
 },[visible,animate]);
 return <div className="blur-presence" ref={root}><div ref={source} className="blur-presence-source" style={{opacity:initial?1:0,filter:initial?'blur(0px)':'blur(12px)',visibility:initial?'visible':'hidden'}}>{children}</div></div>;
}
