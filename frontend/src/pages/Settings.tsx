import {useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {useT} from '../i18n';
import {getState, subscribe} from '../lib/store';
import {navigate} from '../router';
import {meetingSnapshot, storedMeetingIdentity, subscribeMeeting} from '../services/meetingClient';
import {useIntro} from '../services/introClient';
import Button from '../ui/Button';
import GridBackdrop, {type GridBackdropApi} from '../components/GridBackdrop';
import BuiltinResourcesNotice from '../components/BuiltinResourcesNotice';
import ArchivePanel from './settings/ArchivePanel';
import AvatarPanel from './panels/Avatar';
import MemoryPanel from './panels/Memory';
import ConfigAction from './settings/ConfigAction';
import DataTransfer from './settings/DataTransfer';
import DesktopSettings from './settings/DesktopSettings';
import McpSettings from './settings/ExtensionsTab';
import GeneralTab from './settings/GeneralTab';
import ModelsTab from './settings/ModelsTab';
import NativeCompanion from './settings/NativeCompanion';
import ModsPanel from './settings/ModsPanel';
import VisionSettings from './settings/VisionSettings';
import '../styles/settings.css';
import '../styles/config-document.css';

const chapters = ['language', 'display', 'sound', 'models', 'memory', 'archive', 'desktop', 'browser', 'tools', 'mods'] as const;
type Chapter = (typeof chapters)[number];
const inset = 24;
const canResumeMeeting = () => meetingSnapshot().state === 'active' || !!storedMeetingIdentity();

export default function Settings() {
  const t = useT();
  const {data: intro} = useIntro();
  const state = useSyncExternalStore(subscribe, getState);
  const scroll = useRef<HTMLDivElement>(null);
  const grid = useRef<GridBackdropApi>(null);
  const [active, setActive] = useState<Chapter>('language');
  const [previewOpen, setPreviewOpen] = useState(false);
  const hasMeeting = useSyncExternalStore(subscribeMeeting, canResumeMeeting);
  const back = intro?.phase === 'return_title' || !hasMeeting ? 'title' : 'chat';
  const guided = !!intro && intro.phase !== 'completed';

  const track = useCallback(() => {
    const el = scroll.current;
    if (!el) return;
    const readingLine = el.scrollTop + inset + 1;
    const maxScroll = el.scrollHeight - el.clientHeight;
    const headings = Array.from(el.querySelectorAll<HTMLElement>('[data-chapter]'));
    // The last heading may be below the reading line when scrolling is clamped.
    const last = maxScroll > 0 && el.scrollTop >= maxScroll - 1
      ? headings.at(-1)
      : headings.filter(section => section.offsetTop <= readingLine).at(-1);
    setActive(last?.dataset.chapter as Chapter ?? 'language');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    grid.current?.setAngle(25 + (reduced ? 0 : el.scrollTop * 0.02));
  }, []);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const resize = new ResizeObserver(track);
    resize.observe(el);
    for (const section of el.querySelectorAll('[data-chapter]')) resize.observe(section);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    media.addEventListener('change', track);
    return () => {resize.disconnect(); media.removeEventListener('change', track);};
  }, [track]);
  function jump(id: Chapter) {
    const el = scroll.current;
    const section = el?.querySelector<HTMLElement>('[data-chapter="'+id+'"]');
    if (!el || !section) return;
    const smooth = !guided && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({top: section.offsetTop - inset, behavior: smooth ? 'smooth' : 'instant'});
  }
  const action = (id: string, children: ReactNode, value?: string) =>
    <ConfigAction label={t('config.' + id)} action={t('config.' + id + 'Action')} value={value}>{children}</ConfigAction>;
  const content: Record<Chapter, ReactNode> = {
    language: <GeneralTab section="language"/>,
    display: <><GeneralTab section="display"/>{action('avatar', <AvatarPanel/>, state.avatars.find(a => a.id === state.avatarId)?.name)}
      <details className="config-preview" onToggle={event => setPreviewOpen(event.currentTarget.open)}><summary>{t('config.preview')}</summary>{previewOpen && <GeneralTab section="preview"/>}</details></>,
    sound: <div className="config-columns">
      <div className="config-group"><GeneralTab section="sound"/></div>
      <div className="config-group"><GeneralTab section="sample"/></div>
    </div>,
    models: guided ? <>
      <ModelsTab section={intro.phase === 'tts' && intro.configurationValid ? 'tts' : 'llm'}/>
      <BuiltinResourcesNotice/>
    </> : <div className="config-columns">
      <div className="config-group">
        {action('llm', <ModelsTab section="llm"/>, state.settings.llm.model)}
        {action('tts', <ModelsTab section="tts"/>, state.settings.tts.voice)}
      </div>
      <div className="config-group"><VisionSettings/><BuiltinResourcesNotice showSpeech/></div>
    </div>,
    memory: guided ? <MemoryPanel/> : <>{action('memories', <MemoryPanel/>)}{action('pinned', <MemoryPanel pinnedOnly/>)}</>,
    archive: <>{action('history', <ArchivePanel/>)}<DataTransfer/></>,
    desktop: <DesktopSettings/>,
    browser: <NativeCompanion plugin="browser" mode="inline"/>,
    tools: <McpSettings/>,
    mods: <ModsPanel/>,
  };
  return <div className="settings-page config-document">
    <GridBackdrop angle={25} api={grid}/>
    <header className="config-header"><h1>{t('settings.title')}</h1><Button variant="ghost" className="config-action" data-intro="settings-back" onClick={() => navigate(back)}>{t(back === 'chat' ? 'common.backChat' : 'common.backTitle')}</Button></header>
    <div className="config-layout">
      <nav className="config-index" aria-label={t('settings.title')}>{chapters.map(id => <Button key={id} data-intro={'tab-' + id}
        aria-controls={'config-' + id} aria-current={active === id ? 'location' : undefined} className={active === id ? 'active' : ''} onClick={() => jump(id)}>{t('config.' + id)}</Button>)}</nav>
      <div className="config-scroll" ref={scroll} onScroll={track}>
        {chapters.map(id => <section key={id} data-chapter={id} id={'config-' + id} aria-labelledby={'heading-' + id}>
          <h2 id={'heading-' + id}>{t('config.' + id)}</h2><div className="config-card">{content[id]}</div>
        </section>)}
      </div>
    </div>
  </div>;
}
