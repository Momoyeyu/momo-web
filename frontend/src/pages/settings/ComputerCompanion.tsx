import {useEffect,useState,useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import {computerSnapshot,subscribeComputer,readComputer,startComputer,stopComputer,configureComputer} from '../../services/computerClient';
import {meetingSnapshot,subscribeMeeting} from '../../services/meetingClient';
import Button from '../../ui/Button';
import Hint from '../../ui/Hint';
import Switch from '../../ui/Switch';
export default function ComputerCompanion(){
 const t=useT(),view=useSyncExternalStore(subscribeComputer,computerSnapshot),meeting=useSyncExternalStore(subscribeMeeting,meetingSnapshot),[error,setError]=useState(false);
 useEffect(()=>{void readComputer().catch(()=>setError(true));},[]);
 const update=(proactive:boolean,reactions:boolean)=>void configureComputer(proactive,reactions).catch(()=>setError(true));
 return <article className="plugin-library-card"><div><strong>{t('computer.title')}</strong><Hint text={t('computer.hint')} side="down"/></div>
 <div className="plugin-library-actions"><Button disabled={view.busy||meeting.state!=='active'} onClick={()=>void startComputer()}>{t('computer.start')}</Button><Button variant="ghost" disabled={!view.status?.observing&&!view.busy} onClick={()=>void stopComputer()}>{t('computer.stop')}</Button></div>
 {meeting.state!=='active'&&<p className="muted">{t('computer.requiresBoot')}</p>}
 <div className="plugin-library-actions"><span>{t('computer.proactive')}</span><Switch on={view.status?.proactive??false} title={t('computer.proactive')} onChange={v=>update(v,view.status?.reactions??false)}/><span>{t('computer.reactions')}</span><Switch on={view.status?.reactions??false} title={t('computer.reactions')} onChange={v=>update(view.status?.proactive??false,v)}/></div>
 {view.status?.observing&&<p className="muted">{t('computer.chatHint')}</p>}
 {(view.error||error)&&<p role="alert">{t('computer.error')}</p>}
 <Hint text={t('computer.controlUnavailable')} side="down"/>
 </article>;
}
