import {useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {useT} from '../i18n';
import {apiJson, jsonInit} from '../services/http';
import {refreshActivities} from '../services/extensionActivities';
import {readComputer, recordDesktopConsent} from '../services/computerClient';
import {
  checkDesktopPermissions, clearPermissionRequest, permissionRequestSnapshot, subscribePermissionRequest,
  type PermissionKind, type PermissionRequest, type SystemPermission,
} from '../services/desktopPermissionGate';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import '../styles/plugin-library.css';
import '../styles/desktop-permissions.css';

type Application = {bundleId: string; name: string};
type Policy = {available: boolean; granted: boolean | null; browserGranted?: boolean; blocked: Application[]; stopUnconfirmed?: boolean};
export type ApplicationScope = 'computer' | 'browser';
export type SystemAccess = {screenPermission: boolean; inputPermission: boolean; applications: Application[]};
type SystemGuideRequest = {kind: SystemPermission; onError?: () => void};
type PermissionProgress = {request: PermissionRequest; shown: PermissionKind[]; missing: PermissionKind[]};
const endpoint = '/api/computer/access';
const guideEvent = 'momo:desktop-access-guide';
const systemGuideEvent = 'momo:desktop-system-guide';
const accessChanged = 'momo:desktop-access-changed';
const systemPermissions = ['screen', 'input'] as const;
const kinds = ['access', ...systemPermissions] as const;

export function openDesktopAccessGuide() {
  window.dispatchEvent(new Event(guideEvent));
}

export function authorizeSystemPermission(kind: SystemPermission, onError?: () => void) {
  window.dispatchEvent(new CustomEvent<SystemGuideRequest>(systemGuideEvent, {detail: {kind, onError}}));
}

export function readSystemAccess(signal?: AbortSignal) {
  return apiJson<SystemAccess>(endpoint + '/system', {signal});
}

export function isSystemPermissionGranted(system: SystemAccess | null, kind: SystemPermission) {
  return !!(kind === 'screen' ? system?.screenPermission : system?.inputPermission);
}

export function DesktopPermissionAction({kind, granted, disabled, onClick}: {
  kind: PermissionKind; granted: boolean; disabled?: boolean; onClick: () => void;
}) {
  const t = useT();
  const label = t(granted ? 'desktopAccess.enabled' : 'desktopAccess.configure');
  return <Button
    className={granted ? 'desktop-permission-action is-granted' : 'desktop-permission-action'}
    variant={granted ? 'ghost' : 'solid'}
    disabled={granted || disabled}
    aria-label={t('desktopAccess.actionLabel', {permission: t(kind === 'access' ? 'desktopAccess.title' : 'desktopAccess.' + kind), action: label})}
    onClick={onClick}
  >{label}</Button>;
}

export function readDesktopAccess(signal?: AbortSignal) {
  return apiJson<Policy>(endpoint, {signal});
}

export async function setDesktopConsent(granted: boolean, plugin: ApplicationScope = 'computer') {
  const policy = await apiJson<Policy>(endpoint + '/consent', jsonInit('PUT', plugin === 'computer' ? {granted} : {granted, plugin}));
  if (plugin === 'computer') recordDesktopConsent(policy.granted);
  window.dispatchEvent(new Event(accessChanged));
  await Promise.allSettled([refreshActivities(), readComputer()]);
  return policy;
}

function ApplicationBlocklist() {
  const t = useT();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [system, setSystem] = useState<SystemAccess | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!window.momoDesktop) return;
    const controller = new AbortController();
    const {signal} = controller;
    const showError = () => { if (!signal.aborted) setError(true); };
    const loadPolicy = () => { void apiJson<Policy>(endpoint, {signal}).then(setPolicy).catch(showError); };
    const loadSystem = () => { void readSystemAccess(signal).then(setSystem).catch(showError); };
    loadPolicy();
    loadSystem();
    window.addEventListener('focus', loadSystem);
    window.addEventListener(accessChanged, loadPolicy);
    return () => {
      controller.abort();
      window.removeEventListener('focus', loadSystem);
      window.removeEventListener(accessChanged, loadPolicy);
    };
  }, []);

  async function changeBlock(app: Application, blocked: boolean) {
    setBusy(true);
    setError(false);
    try {
      const updated = await apiJson<Policy>(endpoint + '/blocklist', jsonInit('PUT', {...app, blocked}));
      setPolicy(previous => previous && {...previous, ...updated});
      setSelected('');
    } catch { setError(true); }
    finally { setBusy(false); }
  }

  if (!policy?.available) {
    return <p role={error ? 'alert' : 'status'}>{t(error ? 'permissions.error' : policy ? 'activities.platformUnsupported' : 'config.loading')}</p>;
  }
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
      <Button variant="ghost" disabled={busy} onClick={() => void changeBlock(app, false)}>{t('desktopAccess.unblock')}</Button>
    </div>)}
    <div className="permission-app">
      <select className="extension-window-select" aria-label={t('desktopAccess.select')} value={selected}
        onChange={event => setSelected(event.target.value)}>
        <option value="">{t('desktopAccess.select')}</option>
        {candidates.map(app => <option key={app.bundleId} value={app.bundleId}>{app.name}</option>)}
      </select>
      <Button disabled={!app || busy} onClick={() => app && void changeBlock(app, true)}>{t('desktopAccess.block')}</Button>
    </div>
    {(error || policy.stopUnconfirmed) && <p role="alert">{t(policy.stopUnconfirmed ? 'plugins.stopUnknown' : 'permissions.error')}</p>}
  </section>;
}

function PermissionDialogs({ready, onGuideVisibility}: {
  ready: boolean; onGuideVisibility?: (visible: boolean) => void;
}) {
  const t = useT();
  const request = useSyncExternalStore(subscribePermissionRequest, permissionRequestSnapshot);
  const [progress, setProgress] = useState<PermissionProgress | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [system, setSystem] = useState<SystemAccess | null>(null);
  const [guide, setGuide] = useState(false);
  const [follower, setFollower] = useState<SystemGuideRequest | null>(null);
  const activeFollower = useRef<SystemGuideRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState(false);
  const guideVisible = ready && guide && policy?.available === true;
  const visible = guideVisible || (ready && !!request);
  useLayoutEffect(() => { onGuideVisibility?.(visible); }, [visible, onGuideVisibility]);

  const refreshSystem = useCallback(async (signal?: AbortSignal) => {
    const result = await readSystemAccess(signal);
    if (!signal?.aborted) setSystem(result);
    return result;
  }, []);

  const refreshRequest = useCallback(async (current: PermissionRequest, signal?: AbortSignal) => {
    const missing = await checkDesktopPermissions(current.operation, signal);
    if (signal?.aborted || permissionRequestSnapshot() !== current) return false;
    setProgress(previous => {
      const shown = new Set(previous?.request === current ? previous.shown : current.missing);
      missing.forEach(kind => shown.add(kind));
      return {request: current, shown: kinds.filter(kind => shown.has(kind)), missing};
    });
    return missing.length === 0;
  }, []);

  useEffect(() => {
    if (!ready || !window.momoDesktop) return;
    const controller = new AbortController();
    const {signal} = controller;
    const showError = () => { if (!signal.aborted) setError(true); };
    const open = () => {
      setError(false);
      void apiJson<Policy>(endpoint, {signal}).then(value => {
        if (signal.aborted) return;
        setPolicy(value);
        setGuide(value.available);
        if (value.available) void refreshSystem(signal).catch(showError);
      }).catch(showError);
    };
    window.addEventListener(guideEvent, open);
    void apiJson<Policy>(endpoint, {signal}).then(async value => {
      if (signal.aborted) return;
      setPolicy(value);
      if (!value.available || value.granted === false) return;
      if (value.granted === null) setGuide(true);
      const current = await refreshSystem(signal);
      if (!signal.aborted && (!current.screenPermission || !current.inputPermission)) setGuide(true);
    }).catch(showError);
    return () => {
      controller.abort();
      window.removeEventListener(guideEvent, open);
    };
  }, [ready, refreshSystem]);

  useEffect(() => {
    if (!ready || !window.momoDesktop) return;
    const controller = new AbortController();
    const {signal} = controller;
    const showError = () => { if (!signal.aborted) setError(true); };
    const refresh = () => {
      const current = permissionRequestSnapshot();
      if (current) void refreshRequest(current, signal).catch(showError);
      if (guideVisible) void refreshSystem(signal).catch(showError);
    };
    const closeFollower = () => {
      if (!activeFollower.current) return;
      activeFollower.current = null;
      setFollower(null);
      window.dispatchEvent(new Event(accessChanged));
      refresh();
    };
    const unsubscribe = window.momoDesktop.onPermissionGuideClosed?.(closeFollower);
    window.addEventListener('focus', refresh);
    return () => {
      unsubscribe?.();
      controller.abort();
      window.removeEventListener('focus', refresh);
    };
  }, [ready, guideVisible, refreshRequest, refreshSystem]);

  const openSystem = useCallback(async (entry: SystemGuideRequest) => {
    const bridge = window.momoDesktop;
    if (!bridge || activeFollower.current) return;
    const {kind} = entry;
    if (bridge.openPermissionGuide && bridge.onPermissionGuideClosed) {
      activeFollower.current = entry;
      setFollower(entry);
      try {
        await bridge.openPermissionGuide(kind, {
          title: t('desktopAccess.guideTitle', {permission: t('desktopAccess.' + kind)}),
          instructions: t('desktopAccess.guideInstructions'),
          dragLabel: 'momo.app',
          doneLabel: t('desktopAccess.guideDone'),
          grantedLabel: t('desktopAccess.guideGranted'),
          closeLabel: t('desktopAccess.guideClose'),
          openSettingsLabel: t('desktopAccess.systemAction'),
          revealLabel: t('desktopAccess.guideReveal'),
        });
      } catch (cause) {
        if (activeFollower.current === entry) {
          activeFollower.current = null;
          setFollower(null);
          await bridge.closePermissionGuide?.().catch(() => {});
        }
        throw cause;
      }
      return;
    }
    if (bridge.requestSystemPermission) {
      await bridge.requestSystemPermission(kind);
      await refreshSystem();
    } else {
      setSystem(await apiJson<SystemAccess>(endpoint + '/system/' + kind, {method: 'POST'}));
    }
    window.dispatchEvent(new Event(accessChanged));
    const current = permissionRequestSnapshot();
    if (current) await refreshRequest(current);
  }, [refreshRequest, refreshSystem, t]);

  useEffect(() => {
    if (!ready || !window.momoDesktop) return;
    const authorize = (event: Event) => {
      const entry = (event as CustomEvent<SystemGuideRequest>).detail;
      void openSystem(entry).catch(() => entry.onError ? entry.onError() : setError(true));
    };
    window.addEventListener(systemGuideEvent, authorize);
    return () => window.removeEventListener(systemGuideEvent, authorize);
  }, [ready, openSystem]);

  useEffect(() => () => {
    if (activeFollower.current) {
      activeFollower.current = null;
      void window.momoDesktop?.closePermissionGuide?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!follower) return;
    const controller = new AbortController();
    const {signal} = controller;
    let timer: ReturnType<typeof setTimeout>;
    let granted = false;
    async function poll() {
      try {
        const current = await refreshSystem(signal);
        if (signal.aborted || activeFollower.current !== follower) return;
        const next = isSystemPermissionGranted(current, follower!.kind);
        if (next !== granted) {
          await window.momoDesktop?.setPermissionGuideGranted?.(next);
          granted = next;
        }
      } catch { /* Retry transient check and bridge failures while the guide is open. */ }
      if (!signal.aborted) timer = setTimeout(() => void poll(), 800);
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [follower, refreshSystem]);

  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(false);
    try { await action(); }
    catch { setError(true); }
    finally { working.current = false; setBusy(false); }
  }

  async function decide(granted: boolean) {
    const updated = await setDesktopConsent(granted);
    setPolicy(previous => previous && {...previous, ...updated});
    setGuide(false);
  }

  if (!visible || follower) return null;
  const current = progress?.request === request ? progress : null;
  const missing = request ? current?.missing ?? request.missing : [];
  const shown = request ? current?.shown ?? request.missing : systemPermissions;
  const complete = system?.screenPermission && system.inputPermission;
  const title = t(request ? 'desktopAccess.requestTitle' : 'desktopAccess.title');
  const dismiss = () => {
    if (working.current) return;
    if (request) {
      setProgress(null);
      setError(false);
      clearPermissionRequest(request);
    } else if (policy?.granted === null) void run(() => decide(false));
    else setGuide(false);
  };
  const grantAccess = async (current: PermissionRequest) => {
    const updated = await setDesktopConsent(true);
    setPolicy(previous => previous && {...previous, ...updated});
    await refreshRequest(current);
  };
  return <Modal className="desktop-permission-modal" label={title} describedBy="desktop-permission-description" onClose={dismiss}>
    <header className="desktop-permission-header">
      <img src="/brand/momo-icon.svg" alt="" width="32" height="32"/>
      <div>
        <h2>{title}</h2>
        <p id="desktop-permission-description">{t(request ? 'desktopAccess.operation.' + request.operation : 'desktopAccess.description')}</p>
      </div>
      <Button className="icon-btn" variant="ghost" aria-label={t('desktopAccess.close')} disabled={busy} onClick={dismiss}><Icon name="close"/></Button>
    </header>
    <section aria-label={t(request ? 'desktopAccess.accessGroup' : 'desktopAccess.system')} className="desktop-permission-rows">
      {shown.map(kind => {
        const granted = request ? !missing.includes(kind) : kind !== 'access' && isSystemPermissionGranted(system, kind);
        return <div className="desktop-permission-row" key={kind}>
          <div>
            <strong>{t(kind === 'access' ? 'desktopAccess.title' : 'desktopAccess.' + kind)}</strong>
            <p>{t('desktopAccess.' + kind + 'Hint')}</p>
          </div>
          <DesktopPermissionAction kind={kind} granted={granted} disabled={busy || (!request && !system)} onClick={() => {
            if (kind !== 'access') void run(() => openSystem({kind}));
            else if (request) void run(() => grantAccess(request));
          }}/>
        </div>;
      })}
    </section>
    {error && <p role="alert" className="desktop-permission-error">{t(request ? 'permissions.error' : 'desktopAccess.settingsHelp')}</p>}
    <footer className="desktop-permission-footer">
      {request ? <>
        <span role="status">{missing.length ? t('desktopAccess.remaining', {count:String(missing.length)}) : t('desktopAccess.allGranted')}</span>
        <div className="desktop-permission-buttons">
          <Button variant="ghost" disabled={busy} onClick={dismiss}>{t('desktopAccess.cancelOperation')}</Button>
          <Button disabled={busy || missing.length > 0} onClick={() => void run(async () => {
            if (!await refreshRequest(request) || !clearPermissionRequest(request)) return;
            setProgress(null);
            setGuide(false);
            await request.continueAction();
          })}>{t('desktopAccess.continueOperation')}</Button>
        </div>
      </> : <div className="desktop-permission-buttons">
        {policy?.granted && <Button variant="ghost" disabled={busy} onClick={() => void run(() => decide(false))}>{t('desktopAccess.disable')}</Button>}
        <Button variant="ghost" disabled={busy} onClick={dismiss}>{t(policy?.granted ? 'browser.dismiss' : 'desktopAccess.later')}</Button>
        <Button disabled={!complete || busy} onClick={() => void run(() => decide(true))}>{t('desktopAccess.enable')}</Button>
      </div>}
    </footer>
  </Modal>;
}

export default function AppPermissions({manage = false, ready = false, onGuideVisibility}: {
  manage?: boolean; ready?: boolean; onGuideVisibility?: (visible: boolean) => void;
}) {
  return manage ? <ApplicationBlocklist/> : <PermissionDialogs ready={ready} onGuideVisibility={onGuideVisibility}/>;
}
