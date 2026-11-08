import {useState,useSyncExternalStore} from 'react';
import {useT} from '../i18n';
import {computerSnapshot,subscribeComputer,configureComputer} from '../services/computerClient';
import {meetingSnapshot,subscribeMeeting} from '../services/meetingClient';
import Button from '../ui/Button';
import Icon from '../ui/Icon';

/** One preference for Chat and the desktop pet; unrelated to TTS mute. */
export default function ProactiveResponseToggle(){
 const t=useT(),view=useSyncExternalStore(subscribeComputer,computerSnapshot);
 const meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot);
 const [saving,setSaving]=useState(false),[failed,setFailed]=useState(false);
 const enabled=!!(view.status?.proactive&&view.status.reactions);
 const toggle=async()=>{
  if(saving)return;
  setSaving(true);setFailed(false);
  try{await configureComputer(!enabled,!enabled);}catch{setFailed(true);}finally{setSaving(false);}
 };
 return <Button className={`tb tb-proactive tip${enabled?' is-active':''}`} aria-label={t('desktop.react')} aria-pressed={enabled}
  data-tip={t('desktop.react')} data-tip-detail={t(failed?'desktop.error':'desktop.reactHint')}
  disabled={saving||!view.status||meeting.attention.focus} onClick={()=>void toggle()}><Icon name="proactive"/></Button>;
}
