import {useEffect, useState, useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import AppPermissions, {openDesktopAccessGuide, setDesktopConsent, type SystemAccess} from '../../components/AppPermissions';
import {computerSnapshot, configureComputer, readComputer, setDesktopObservation, subscribeComputer} from '../../services/computerClient';
import Button from '../../ui/Button';
import FieldRow from '../../ui/FieldRow';
import Switch from '../../ui/Switch';
import NativeCompanion from './NativeCompanion';
import {apiJson} from '../../services/http';
import ConfigAction from './ConfigAction';

export default function DesktopSettings() {
  const t = useT();
  const {status, confirmedConsent, busy, error} = useSyncExternalStore(subscribeComputer, computerSnapshot);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [system, setSystem] = useState<SystemAccess | 'error'>();
  const native = !!window.momoDesktop;
  useEffect(() => { void readComputer().catch(() => setFailed(true)); }, []);
  useEffect(() => {
    if (!native) return;
    let controller: AbortController;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const {signal} = controller;
      void apiJson<SystemAccess>('/api/computer/access/system', {signal})
        .then(value => {if (!signal.aborted) setSystem(value);})
        .catch(() => {if (!signal.aborted) setSystem('error');});
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('momo:desktop-access-changed', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('momo:desktop-access-changed', refresh);
    };
  }, [native]);
  const consent = status ? status.desktopAccessGranted : confirmedConsent;
  const granted = consent === true;
  const accessStatus = !native ? 'config.nativeOnly' : status || consent !== undefined
    ? (granted ? 'desktopAccess.enabled' : 'config.grantedOff')
    : (failed ? 'config.unavailable' : 'config.loading');
  const disabled = !native || !status || saving || busy;
  async function changeAccess(on: boolean) {
    if (on && (!system || system === 'error' || !system.screenPermission || !system.inputPermission)) {
      openDesktopAccessGuide();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      const updated = await setDesktopConsent(on);
      if (updated.stopUnconfirmed) setFailed(true);
    } catch { setFailed(true); }
    finally { setSaving(false); }
  }
  async function openSystem(kind: 'screen' | 'input') {
    setFailed(false);
    try { await window.momoDesktop?.requestSystemPermission?.(kind); }
    catch { setFailed(true); }
  }
  async function configure(on: boolean) {
    setSaving(true);
    setFailed(false);
    try { await configureComputer(on, on); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  }
  return <div className="desktop-config">
    <FieldRow label={t('desktopAccess.title')} hint={native ? t('desktopAccess.description') : undefined}>
      <span className="config-value" role="status">{t(accessStatus)}</span>
      <Switch title={t('desktopAccess.title')} on={granted} disabled={!native || (!status && consent === undefined) || saving || busy} onChange={on => void changeAccess(on)}/>
    </FieldRow>
    {native && (['screen','input'] as const).map(kind => {
      const key = kind === 'screen' ? 'screenPermission' : 'inputPermission';
      const state = !system ? 'config.loading' : system === 'error' ? 'config.unavailable'
        : system[key] ? 'desktopAccess.enabled' : 'config.grantedOff';
      return <FieldRow key={kind} label={t('desktopAccess.' + kind)}>
        <span className="config-value" role="status">{t(state)}</span>
        <Button className="config-action" variant="ghost" onClick={() => {
          if (window.momoDesktop?.requestSystemPermission) void openSystem(kind);
          else openDesktopAccessGuide();
        }}>{t('desktopAccess.systemAction')}</Button>
      </FieldRow>;
    })}
    <FieldRow label={t('desktop.observe')} hint={t(!native ? 'config.nativeOnly' : 'desktop.observeHint')}>
      <Switch title={t('desktop.observe')} on={!!status?.desktopAllowed} disabled={disabled} onChange={on => void setDesktopObservation(on, 'settings')}/>
    </FieldRow>
    <FieldRow label={t('desktop.react')} hint={t('desktop.reactHint')}>
      <Switch title={t('desktop.react')} on={!!(status?.proactive && status.reactions)} disabled={disabled} onChange={on => void configure(on)}/>
    </FieldRow>
    <ConfigAction label={t('computer.title')} action={t('config.windowAction')}>
      <NativeCompanion plugin="computer" mode="activity"/>
    </ConfigAction>
    <ConfigAction label={t('desktopAccess.blocklist')} action={t('config.blockAction')}>
      {native ? <AppPermissions manage/> : <p>{t('config.nativeOnly')}</p>}
    </ConfigAction>
    {(failed || error) && <p role="alert">{t('permissions.error')}</p>}
  </div>;
}
