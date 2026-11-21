import {useEffect, useState} from 'react';
import {useT} from '../../i18n';
import {
  authorizeSystemPermission, DesktopPermissionAction, isSystemPermissionGranted,
  readDesktopAccess, readSystemAccess, setDesktopConsent, type ApplicationScope, type SystemAccess,
} from '../../components/AppPermissions';
import FieldRow from '../../ui/FieldRow';
import Switch from '../../ui/Switch';

export default function DesktopSettings() {
  const t = useT();
  const native = !!window.momoDesktop;
  const [policy, setPolicy] = useState<Awaited<ReturnType<typeof readDesktopAccess>>>();
  const [system, setSystem] = useState<SystemAccess | 'error'>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!native) return;
    let controller: AbortController;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const {signal} = controller;
      void readDesktopAccess(signal)
        .then(value => {if (!signal.aborted) setPolicy(value);})
        .catch(() => {if (!signal.aborted) setFailed(true);});
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

  async function changeAccess(plugin: ApplicationScope, granted: boolean) {
    setSaving(true);
    setFailed(false);
    try {
      const updated = await setDesktopConsent(granted, plugin);
      setPolicy(previous => previous && {...previous, ...updated});
      if (updated.stopUnconfirmed) setFailed(true);
    } catch { setFailed(true); }
    finally { setSaving(false); }
  }

  const desktop = t('desktopAccess.title');
  const browser = t('desktopAccess.browserAccess');
  const disabled = !native || !policy?.available || saving;
  return <div className="desktop-config">
    <div className={native ? 'config-split config-split-stack' : undefined}>
      <div className="desktop-config-column" role="group" aria-label={t('desktopAccess.accessGroup')}>
        <FieldRow label={desktop} hint={t(native ? 'desktopAccess.description' : 'config.nativeOnly')}>
          <Switch title={desktop} on={policy?.granted === true} disabled={disabled} onChange={on => void changeAccess('computer', on)}/>
        </FieldRow>
        <FieldRow label={browser} hint={t(native ? 'desktopAccess.browserHint' : 'config.nativeOnly')}>
          <Switch title={browser} on={policy?.browserGranted === true} disabled={disabled} onChange={on => void changeAccess('browser', on)}/>
        </FieldRow>
      </div>
      {native && <div className="desktop-config-column" role="group" aria-label={t('desktopAccess.system')}>
        {(['screen', 'input'] as const).map(kind => <FieldRow key={kind} label={t('desktopAccess.' + kind)}>
          {!system || system === 'error'
            ? <span className="config-value" role="status">{t(system === 'error' ? 'config.unavailable' : 'config.loading')}</span>
            : <DesktopPermissionAction kind={kind} granted={isSystemPermissionGranted(system, kind)} onClick={() => {
              setFailed(false);
              authorizeSystemPermission(kind, () => setFailed(true));
            }}/>}
        </FieldRow>)}
      </div>}
    </div>
    {failed && <p role="alert">{t('permissions.error')}</p>}
  </div>;
}
