import {Fragment, useEffect, useMemo, useState} from 'react';
import {ClockFace, Combobox} from '@momoyeyu/momo-ui';
import '@momoyeyu/momo-ui/styles.css';
import {currentLang, useT} from '../i18n';
import {updateGeneral} from '../lib/store';
import type {Memory} from '../lib/types';
import {listMemories} from '../services/memoryClient';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import {formatPhoneTime, usePhoneTimeZone} from './phoneTime';
import type {PhoneApp, PhoneViewProps} from './registry';

type BuiltinViewProps = Pick<PhoneViewProps, 'setApp' | 'now'>;

function AppHeader({title, goHome}: {title: string; goHome: () => void}) {
  const t = useT();
  return <header className="phone-app-header">
    <Button variant="ghost" className="phone-nav" aria-label={t('phone.back')} onClick={goHome}>
      <Icon name="back" size={15}/>
    </Button>
    <h2 className="phone-app-title">{title}</h2>
  </header>;
}

function NotebookView({setApp}: BuiltinViewProps) {
  const t = useT();
  const lang = currentLang();
  const zone = usePhoneTimeZone();
  const [notes, setNotes] = useState<Memory[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const request = new AbortController();
    void listMemories(request.signal).then(memories => {
      if (!request.signal.aborted) setNotes(memories);
    }).catch(() => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
  }, [attempt]);

  const groups = useMemo(() => {
    const dates = new Intl.DateTimeFormat(lang, {dateStyle:'long',timeZone:zone || undefined});
    const grouped = new Map<string, Memory[]>();
    for (const note of [...(notes ?? [])].sort((a,b) => b.createdAt.localeCompare(a.createdAt))) {
      const date = new Date(note.createdAt);
      const heading = Number.isFinite(date.getTime()) ? dates.format(date) : '';
      const entries = grouped.get(heading) ?? [];
      entries.push(note);
      grouped.set(heading, entries);
    }
    return [...grouped];
  }, [notes, lang, zone]);

  return <>
    <AppHeader title={t('phone.notebook')} goHome={() => setApp(null)}/>
    <div className="phone-scroll phone-notes">
      {failed ? <div className="phone-empty" role="status">
        {t('phone.notesFailed')}
        <Button variant="ghost" size="sm" onClick={() => {setFailed(false);setAttempt(value=>value+1);}}>
          {t('phone.notesRetry')}
        </Button>
      </div> : notes === null ? <div className="phone-empty" role="status">{t('phone.notesLoading')}</div>
        : notes.length === 0 ? <div className="phone-empty">{t('phone.notesEmpty')}</div>
          : groups.map(([date, entries]) => <Fragment key={date}>
            {date && <h3>{date}</h3>}
            {entries.map(note => <p key={note.id}>{note.content}</p>)}
          </Fragment>)}
    </div>
  </>;
}

function ClockView({setApp, now}: BuiltinViewProps) {
  const t = useT();
  const lang = currentLang();
  const zone = usePhoneTimeZone();
  const deviceZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const systemLabel = t('phone.systemTimeZone', {zone:deviceZone});
  const options = useMemo(() => {
    const zones = [...new Set(['UTC', deviceZone, ...Intl.supportedValuesOf('timeZone'), ...(zone ? [zone] : [])])].sort();
    return [{value:'', label:systemLabel}, ...zones.map(value => ({value, label:value.replaceAll('_',' ')}))];
  }, [deviceZone, zone, systemLabel]);
  const date = new Intl.DateTimeFormat(lang, {dateStyle:'full', timeZone:zone || undefined}).format(now);

  return <>
    <AppHeader title={t('phone.clock')} goHome={() => setApp(null)}/>
    <div className="phone-scroll phone-clock">
      <ClockFace time={formatPhoneTime(now,lang,zone)} dateTime={now.toISOString()} date={date}/>
      <label htmlFor="phone-time-zone">{t('phone.timeZone')}</label>
      <Combobox id="phone-time-zone" label={t('phone.timeZone')} value={zone}
        onChange={phoneTimeZone => updateGeneral({phoneTimeZone})} options={options}
        searchLabel={t('phone.searchTimeZone')} emptyLabel={t('phone.noTimeZones')}/>
    </div>
  </>;
}

export const builtinPhoneApps: PhoneApp[] = [
  {id:'notebook', labelKey:'phone.notebook', icon:<Icon name="notebook"/>, render:props=><NotebookView {...props}/>},
  {id:'clock', labelKey:'phone.clock', icon:<Icon name="clock"/>, render:props=><ClockView {...props}/>},
];
