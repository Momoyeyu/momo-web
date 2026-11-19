import {createPortal} from 'react-dom';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useT} from '../i18n';
import {useActivities} from '../services/extensionActivities';
import {desktopWindowAvailable,setDesktopMode} from '../services/desktopWindow';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import MinecraftCompanion from './settings/MinecraftCompanion';
import '../styles/plugin-library.css';
/** Game control remains usable when the independent desktop plugin is disabled. */
export default function ExtensionActivities(){
 const t=useT(),enabled=useActivities(),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const [gameOpen,setGameOpen]=useState(false),trigger=useRef<HTMLButtonElement|null>(null),panel=useRef<HTMLDivElement|null>(null);
 const close=()=>{setGameOpen(false);trigger.current?.focus();};
 useEffect(()=>{if(!enabled.minecraft)setGameOpen(false);},[enabled.minecraft]);
 useEffect(()=>{
  if(!gameOpen)return;
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!panel.current?.contains(event.target)&&!trigger.current?.contains(event.target))setGameOpen(false);};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}};
  document.addEventListener('pointerdown',outside,true);window.addEventListener('keydown',escape,true);
  return()=>{document.removeEventListener('pointerdown',outside,true);window.removeEventListener('keydown',escape,true);};
 },[gameOpen]);
 useLayoutEffect(()=>{
  if(!gameOpen||!panel.current)return;
  const place=()=>{const box=panel.current,button=trigger.current;if(!box||!button)return;const rail=button.getBoundingClientRect(),stage=button.closest('.chat-page')?.getBoundingClientRect();
   const top=stage?.top??0,bottom=stage?.bottom??innerHeight;
   box.style.maxHeight=`${Math.max(120,bottom-top-24)}px`;
   box.style.width=`${Math.min(360,Math.max(180,(stage?.width??innerWidth)/2-92))}px`;
   box.style.right=`${innerWidth-rail.left+12}px`;
   box.style.top=`${Math.max(top+12,Math.min(rail.top+rail.height/2-box.offsetHeight/2,bottom-box.offsetHeight-12))}px`;
  };
  place();panel.current.focus();const observer=new ResizeObserver(place);observer.observe(panel.current);window.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);};
 },[gameOpen]);
 const enter=async()=>{if(busy)return;setBusy(true);setError(false);try{await setDesktopMode('pet');}catch{setError(true);}finally{setBusy(false);}};
 return <>
  {desktopWindowAvailable()&&<Button className="tb tip" data-tip={t('desktop.enter')} data-tip-detail={t('desktop.enterHint')} aria-label={t('desktop.enter')} disabled={busy} onClick={()=>void enter()}><Icon name="desktop"/></Button>}
  {enabled.minecraft&&<Button className={`tb tb-game tip${gameOpen?' is-active':''}`} aria-label={t('minecraft.title')} data-tip={t('minecraft.title')} aria-haspopup="dialog" aria-expanded={gameOpen} aria-controls={gameOpen?'chat-game-activity':undefined} onClick={event=>{trigger.current=event.currentTarget;setGameOpen(!gameOpen);}}><Icon name="gamepad"/></Button>}
  {gameOpen&&enabled.minecraft&&createPortal(<div id="chat-game-activity" ref={panel} className="chat-game-activity" role="dialog" aria-label={t('minecraft.title')} tabIndex={-1}><MinecraftCompanion mode="activity" onDismiss={close}/></div>,document.body)}
  {error&&<div role="alert" className="desktop-action-error">{t('desktop.error')}</div>}
 </>;
}
