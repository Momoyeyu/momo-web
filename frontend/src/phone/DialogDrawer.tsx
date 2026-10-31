import {useLayoutEffect,useRef,type ReactNode} from 'react';
/** Move the original panel, leaving its own top edge as the pull-out lip. */
export default function DialogDrawer({children}:{children:ReactNode}){
 const ref=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const el=ref.current,box=el?.querySelector<HTMLElement>('.dialog-box');if(!el||!box)return;
  const measure=()=>{
   const scale=el.getBoundingClientRect().height/el.clientHeight||1;
   const top=(box.getBoundingClientRect().top-el.getBoundingClientRect().top)/scale;
   el.style.setProperty('--drawer-travel',`${Math.max(0,el.clientHeight-top-28)}px`);
  };
  let disposed=false;
  void Promise.allSettled((el.querySelector('.dialog-zone')?.getAnimations()??[]).map(a=>a.finished)).then(()=>{if(!disposed)measure();});
  const observer=new ResizeObserver(measure);observer.observe(el);observer.observe(box);measure();
  return()=>{disposed=true;observer.disconnect();};
 },[]);
 return <div className="dialog-drawer" ref={ref}>{children}</div>;
}
