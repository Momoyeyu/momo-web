import {useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {useT} from '../i18n';
import {getState, subscribe} from '../lib/store';
import {fromRoute, navigate} from '../router';
import {storedMeetingIdentity} from '../services/meetingClient';
import {useIntro} from '../services/introClient';
import Button from '../ui/Button';
import GridBackdrop, {type GridBackdropApi} from '../components/GridBackdrop';
import BuiltinResourcesNotice from '../components/BuiltinResourcesNotice';
import ArchivePanel from './settings/ArchivePanel';
import AvatarPanel from './panels/Avatar';
import MemoryPanel from './panels/Memory';
import AsrStatus from './settings/AsrStatus';
import ConfigAction from './settings/ConfigAction';
import DataTransfer from './settings/DataTransfer';
import DesktopSettings from './settings/DesktopSettings';
import McpSettings from './settings/ExtensionsTab';
import GeneralTab from './settings/GeneralTab';
import ModelsTab from './settings/ModelsTab';
import NativeCompanion from './settings/NativeCompanion';
import ModsPanel from './settings/ModsPanel';
import '../styles/settings.css';
import '../styles/config-document.css';

const chapters = ['language', 'display', 'sound', 'models', 'memory', 'archive', 'desktop', 'browser', 'tools', 'mods'] as const;
type Chapter = (typeof chapters)[number];
const inset = 24;

export default function Settings() {
  const t = useT();
  const {data: intro} = useIntro();
  const state = useSyncExternalStore(subscribe, getState);
  const scroll = useRef<HTMLDivElement>(null);
  const grid = useRef<GridBackdropApi>(null);
  const [active, setActive] = useState<Chapter>('language');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [source] = useState(() => storedMeetingIdentity() ? 'chat' : fromRoute());
  const back = intro?.phase === 'return_title' || source !== 'chat' ? 'title' : 'chat';
  const guided = !!intro && intro.phase !== 'completed';

  const track = useCallback(() => {
    const el = scroll.current;
    if (!el) return;
    const readingLine = el.getBoundingClientRect().top + inset + 1;
    const headings = Array.from(el.querySelectorAll<HTMLElement>('[data-chapter]'));
    const last = headings.filter(section => section.getBoundingClientRect().top <= readingLine).at(-1);
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
    el.scrollTo({top: section.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - inset, behavior: smooth ? 'smooth' : 'instant'});
  }
  const action = (id: string, children: ReactNode, value?: string) =>
    <ConfigAction label={t('config.' + id)} action={t('config.' + id + 'Action')} value={value}>{children}</ConfigAction>;
  const content: Record<Chapter, ReactNode> = {
    language: <GeneralTab section="language"/>,
    display: <><GeneralTab section="display"/>{action('avatar', <AvatarPanel/>, state.avatars.find(a => a.id === state.avatarId)?.name)}
      <details className="config-preview" onToggle={event => setPreviewOpen(event.currentTarget.open)}><summary>{t('config.preview')}</summary>{previewOpen && <GeneralTab section="preview"/>}</details></>,
    sound: <><GeneralTab section="sound"/>
      <ConfigAction label={t('config.sampleSound')} action={t('settings.soundPreview')}>
        <GeneralTab section="sample"/>
      </ConfigAction></>,
    models: <>{guided ? <ModelsTab section={intro.phase === 'tts' && intro.configurationValid ? 'tts' : 'llm'}/> : <>
      {action('llm', <ModelsTab section="llm"/>, state.settings.llm.model)}
      {action('vision', <ModelsTab section="vision"/>, t(state.settings.llm.vision ? 'browser.active' : 'browser.inactive'))}
      {action('asr', <AsrStatus/>, 'SenseVoice')}
      {action('tts', <ModelsTab section="tts"/>, state.settings.tts.voice)}
    </>}<BuiltinResourcesNotice/></>,
    memory: guided ? <MemoryPanel/> : <>{action('memories', <MemoryPanel/>)}{action('pinned', <MemoryPanel pinnedOnly/>)}</>,
    archive: <>{action('history', <ArchivePanel/>)}{action('backup', <DataTransfer mode="export"/>)}{action('restore', <DataTransfer mode="restore"/>)}</>,
    desktop: <DesktopSettings/>,
    browser: <NativeCompanion plugin="browser" mode="entry"/>,
    tools: action('mcp', <McpSettings/>),
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
