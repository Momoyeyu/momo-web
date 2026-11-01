import {useEffect,useMemo,useState} from 'react';

/** Full accessible sentence, with a decorative terminal transcription on top. */
export default function TerminalTagline({text,active}:{text:string;active:boolean}){
 const characters=useMemo(()=>Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text),part=>part.segment),[text]);
 const [count,setCount]=useState(()=>matchMedia('(prefers-reduced-motion: reduce)').matches?characters.length:0);
 useEffect(()=>{
  if(!active)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');
  let timer:ReturnType<typeof setTimeout>,index=0;
  const finish=()=>{clearTimeout(timer);setCount(characters.length);};
  if(media.matches){finish();return;}
  setCount(0);
  const tick=()=>{index++;setCount(index);if(index<characters.length)timer=setTimeout(tick,Math.min(70,1200/characters.length));};
  timer=setTimeout(tick,220);
  const reduce=()=>{if(media.matches)finish();};media.addEventListener('change',reduce);
  return()=>{clearTimeout(timer);media.removeEventListener('change',reduce);};
 },[active,characters]);
 return <p className="title-tagline" aria-label={text}>
  <span className="terminal-reserve" aria-hidden="true">&gt; {text}<span className="terminal-cursor"/></span>
  <span className="terminal-line" aria-hidden="true"><span className="terminal-prompt">&gt; </span><span className="terminal-output">{characters.slice(0,count).join('')}</span><span className="terminal-cursor"/></span>
 </p>;
}
