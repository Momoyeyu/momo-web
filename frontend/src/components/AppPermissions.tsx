import {useCallback, useEffect, useLayoutEffect, useState} from 'react';
import {useT} from '../i18n';
import {apiJson, jsonInit} from '../services/http';
import {refreshActivities} from '../services/extensionActivities';
import {readComputer} from '../services/computerClient';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import '../styles/plugin-library.css';

type Application = {bundleId: string; name: string};
type Policy = {available: boolean; granted: boolean | null; blocked: Application[]; stopUnconfirmed?: boolean};
type SystemAccess = {screenPermission: boolean; inputPermission: boolean; applications: Application[]};
const endpoint = '/api/computer/access';
const guideEvent = 'momo:desktop-access-guide';
export function openDesktopAccessGuide() { window.dispatchEvent(new Event(guideEvent)); }

export default function AppPermissions({manage = false, ready = false, onGuideVisibility}: {
  manage?: boolean; ready?: boolean; onGuideVisibility?: (visible: boolean) => void;
}) {
  const t = useT();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [system, setSystem] = useState<SystemAccess | null>(null);
  const [guide, setGuide] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const guideVisible = !manage && guide && policy?.available === true;
  useLayoutEffect(() => { onGuideVisibility?.(guideVisible); }, [guideVisible, onGuideVisibility]);
  const refreshSystem = useCallback(async () => setSystem(await apiJson<SystemAccess>(endpoint + '/system')), []);

  useEffect(() => {
    if (!manage && !ready || !window.momoDesktop) return;
    const controller = new AbortController();
    const open = () => {
      void apiJson<Policy>(endpoint).then(value => {setPolicy(value); setGuide(value.available);}).catch(() => setError(true));
    };
    if (!manage) window.addEventListener(guideEvent, open);
    apiJson<Policy>(endpoint, {signal: controller.signal}).then(value => {
      if (controller.signal.aborted) return;
      setPolicy(value);
      if (!value.available || manage) return;
      if (value.granted === null) setGuide(true);
      else if (value.granted) {
        void apiJson<SystemAccess>(endpoint + '/system', {signal: controller.signal}).then(current => {
          if (controller.signal.aborted) return;
          setSystem(current);
          if (!current.screenPermission || !current.inputPermission) setGuide(true);
        }).catch(() => { if (!controller.signal.aborted) setError(true); });
      }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => {
      controller.abort();
      if (!manage) window.removeEventListener(guideEvent, open);
    };
  }, [manage, ready]);

  useEffect(() => {
    if (!policy?.available || !guide && !manage) return;
    const refresh = () => { void refreshSystem().catch(() => setError(true)); };
    refresh();
    const loadPolicy = () => {void apiJson<Policy>(endpoint).then(setPolicy).catch(() => setError(true));};
    window.addEventListener('focus', refresh);
    if (manage) window.addEventListener('momo:desktop-access-changed',loadPolicy);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('momo:desktop-access-changed',loadPolicy);
    };
  }, [policy?.available, guide, manage, refreshSystem]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try { await action(); }
    catch { setError(true); }
    finally { setBusy(false); }
  }

  async function decide(granted: boolean) {
    const updated = await apiJson<Policy>(endpoint + '/consent', jsonInit('PUT', {granted}));
    setPolicy(previous => ({...previous!, ...updated}));
    setGuide(false);
    window.dispatchEvent(new Event('momo:desktop-access-changed'));
    await Promise.allSettled([refreshActivities(),readComputer()]);
  }

  async function changeBlock(app: Application, blocked: boolean) {
    const updated = await apiJson<Policy>(endpoint + '/blocklist', jsonInit('PUT', {...app, blocked}));
    setPolicy(previous => ({...previous!, ...updated}));
    setSelected('');
  }

  if (!policy?.available) {
    if (!manage) return null;
    return <p role={error ? 'alert' : 'status'}>{t(error ? 'permissions.error' : policy ? 'activities.platformUnsupported' : 'config.loading')}</p>;
  }
  if (manage) {
    const blocked = new Set(policy.blocked.map(app => app.bundleId.toLowerCase()));
    const candidates = [...new Map((system?.applications ?? []).filter(app => !blocked.has(app.bundleId.toLowerCase()))
      .map(app => [app.bundleId, app])).values()];
    const app = candidates.find(candidate => candidate.bundleId === selected);
    return <section>
      <p className="muted">{t('desktopAccess.blockHint')}</p>
      <div className="plugin-library-actions">
        <Button variant="ghost" onClick={openDesktopAccessGuide}>{t('desktopAccess.open')}</Button>
      </div>
      {policy.blocked.map(app => <div className="permission-app" key={app.bundleId}>
        <div><strong>{app.name}</strong><small>{app.bundleId}</small></div>
        <Button variant="ghost" disabled={busy} onClick={() => void run(() => changeBlock(app, false))}>{t('desktopAccess.unblock')}</Button>
      </div>)}
      <div className="permission-app">
        <select className="extension-window-select" aria-label={t('desktopAccess.select')} value={selected}
          onChange={event => setSelected(event.target.value)}>
          <option value="">{t('desktopAccess.select')}</option>
          {candidates.map(app => <option key={app.bundleId} value={app.bundleId}>{app.name}</option>)}
        </select>
        <Button disabled={!app || busy} onClick={() => app && void run(() => changeBlock(app, true))}>{t('desktopAccess.block')}</Button>
      </div>
      {(error || policy.stopUnconfirmed) && <p role="alert">{t(policy.stopUnconfirmed ? 'plugins.stopUnknown' : 'permissions.error')}</p>}
    </section>;
  }

  if (!guide) return null;
  const complete = system?.screenPermission && system.inputPermission;
  const dismiss = () => {
    if (busy) return;
    if (policy.granted === null) void run(() => decide(false));
    else setGuide(false);
  };
  return <Modal className="extension-modal" label={t('desktopAccess.title')} onClose={dismiss}>
    <div className="extension-detail">
      <header className="extension-detail-header"><h3>{t('desktopAccess.title')}</h3></header>
      <p>{t('desktopAccess.description')}</p>
      <section aria-label={t('desktopAccess.system')} className="extension-detail-section">
        {(['screen', 'input'] as const).map(kind => {
          const enabled = kind === 'screen' ? system?.screenPermission : system?.inputPermission;
          return <div className="permission-app" key={kind}>
            <div><strong>{t('desktopAccess.' + kind)}</strong><small>{t('desktopAccess.' + kind + 'Hint')}</small></div>
            {enabled ? <span><Icon name="check"/> {t('desktopAccess.enabled')}</span>
              : <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
                setSystem(await apiJson<SystemAccess>(endpoint + '/system/' + kind, {method: 'POST'}));
              })}>{t('desktopAccess.configure')}</Button>}
          </div>;
        })}
      </section>
      {error && <p role="alert">{t('desktopAccess.settingsHelp')}</p>}
      <div className="plugin-library-actions">
        {policy.granted && <Button variant="ghost" disabled={busy} onClick={() => void run(() => decide(false))}>{t('desktopAccess.disable')}</Button>}
        <Button variant="ghost" disabled={busy} onClick={dismiss}>{t(policy.granted ? 'browser.dismiss' : 'desktopAccess.later')}</Button>
        <Button disabled={!complete || busy} onClick={() => void run(() => decide(true))}>{t('desktopAccess.enable')}</Button>
      </div>
    </div>
  </Modal>;
}
