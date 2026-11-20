import {useEffect, useState, useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import AppPermissions, {
  authorizeSystemPermission, DesktopPermissionAction, isSystemPermissionGranted,
  readSystemAccess, setDesktopConsent, type SystemAccess,
} from '../../components/AppPermissions';
import {computerSnapshot, configureComputer, readComputer, setDesktopObservation, subscribeComputer} from '../../services/computerClient';
import FieldRow from '../../ui/FieldRow';
import Switch from '../../ui/Switch';
import NativeCompanion from './NativeCompanion';
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
      void readSystemAccess(signal)
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
    setSaving(true);
    setFailed(false);
    try {
      const updated = await setDesktopConsent(on);
      if (updated.stopUnconfirmed) setFailed(true);
    } catch { setFailed(true); }
    finally { setSaving(false); }
  }
  async function configure(on: boolean) {
    setSaving(true);
    setFailed(false);
    try { await configureComputer(on, on); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  }
  return <div className="desktop-config">
    <div className="desktop-config-groups">
      <section className="desktop-config-group" aria-labelledby="desktop-access-heading">
        <h3 id="desktop-access-heading">{t('desktopAccess.accessGroup')}</h3>
        <FieldRow label={t('desktopAccess.title')} hint={native ? t('desktopAccess.description') : undefined}>
          <span className={native ? 'desktop-config-status' : 'config-value'} role="status">{t(accessStatus)}</span>
          <Switch title={t('desktopAccess.title')} on={granted} disabled={!native || (!status && consent === undefined) || saving || busy} onChange={on => void changeAccess(on)}/>
        </FieldRow>
        {native && (['screen', 'input'] as const).map(kind => <FieldRow key={kind} label={t('desktopAccess.' + kind)}>
          {!system || system === 'error'
            ? <span className="config-value" role="status">{t(system === 'error' ? 'config.unavailable' : 'config.loading')}</span>
            : <DesktopPermissionAction kind={kind} granted={isSystemPermissionGranted(system, kind)} onClick={() => {
              setFailed(false);
              authorizeSystemPermission(kind, () => setFailed(true));
            }}/>}
        </FieldRow>)}
      </section>
      <section className="desktop-config-group" aria-labelledby="desktop-behavior-heading">
        <h3 id="desktop-behavior-heading">{t('desktopAccess.behaviorGroup')}</h3>
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
      </section>
    </div>
    {(failed || error) && <p role="alert">{t('permissions.error')}</p>}
  </div>;
}
