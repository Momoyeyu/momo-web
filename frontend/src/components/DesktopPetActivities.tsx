import {createPortal} from 'react-dom';
import {useEffect,useRef,useState} from 'react';
import {useT} from '../i18n';
import {setDesktopPanel,useDesktopWindow} from '../services/desktopWindow';
import ProactiveResponseToggle from './ProactiveResponseToggle';
import MinecraftCompanion from '../pages/settings/MinecraftCompanion';
import Icon from '../ui/Icon';
import '../styles/plugin-library.css';

export default function DesktopPetActivities({playing}: {playing: boolean}) {
 const t=useT(), {panel: layout}=useDesktopWindow();
 const [open,setOpen]=useState(false);
 const panel=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>()=>{void setDesktopPanel(false).catch(()=>{});},[]);
 useEffect(()=>{if(open)panel.current?.focus();},[open,layout]);
 useEffect(()=>{
  if(playing)return;
  setOpen(false);
  void setDesktopPanel(false).catch(()=>{});
 },[playing]);
 const close=()=>{
  setOpen(false);
  void setDesktopPanel(false).catch(()=>{});
  trigger.current?.focus();
 };
 const title=t('minecraft.title');
 return <>
  <ProactiveResponseToggle/>
  {playing&&<button ref={trigger} type="button" className="tb tip is-active" aria-label={title} aria-expanded={open} data-tip={title}
    onClick={()=>{if(open)close();else void setDesktopPanel(true).then(()=>setOpen(true)).catch(()=>{});}}><Icon name="gamepad"/></button>}
  {playing&&open&&createPortal(
   <div ref={panel} tabIndex={-1} role="dialog" aria-label={title}
    className={`pet-utility${layout?.width&&layout.width>=220?' is-beside':''}`} data-pet-interactive
    onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}}}>
    <header className="pet-utility-header"><span>{title}</span><button type="button" className="pet-icon" aria-label={t('browser.dismiss')} onClick={close}><Icon name="close"/></button></header>
    <div className="pet-utility-body"><MinecraftCompanion mode="activity"/></div>
   </div>,document.body)}
 </>;
}
