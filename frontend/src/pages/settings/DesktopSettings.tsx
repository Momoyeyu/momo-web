import {useEffect, useState, useSyncExternalStore} from 'react';
import {useT} from '../../i18n';
import AppPermissions, {openDesktopAccessGuide} from '../../components/AppPermissions';
import {computerSnapshot, configureComputer, readComputer, setDesktopObservation, subscribeComputer} from '../../services/computerClient';
import {meetingSnapshot, subscribeMeeting} from '../../services/meetingClient';
import FieldRow from '../../ui/FieldRow';
import Switch from '../../ui/Switch';
import NativeCompanion from './NativeCompanion';
import Button from '../../ui/Button';
import ConfigAction from './ConfigAction';

export default function DesktopSettings() {
  const t = useT();
  const {status, busy, error} = useSyncExternalStore(subscribeComputer, computerSnapshot);
  const meeting = useSyncExternalStore(subscribeMeeting, meetingSnapshot);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const native = !!window.momoDesktop;
  useEffect(() => { void readComputer().catch(() => setFailed(true)); }, []);
  const granted = status?.desktopAccessGranted === true;
  const accessStatus = !native ? 'config.nativeOnly' : status
    ? (granted ? 'desktopAccess.enabled' : 'config.grantedOff')
    : (failed ? 'config.unavailable' : 'config.loading');
  const disabled = !native || !status || saving || busy;
  async function configure(on: boolean) {
    setSaving(true);
    setFailed(false);
    try { await configureComputer(on, on); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  }
  return <>
    <FieldRow label={t('desktopAccess.title')} hint={native ? t('desktopAccess.description') : undefined}>
      <span className="config-value" role="status">{t(accessStatus)}</span>
      {native && <Button variant="ghost" className="config-action" onClick={openDesktopAccessGuide}>{t('config.accessAction')}</Button>}
    </FieldRow>
    <ConfigAction label={t('computer.title')} action={t('config.windowAction')}>
      <NativeCompanion plugin="computer" mode="activity"/>
    </ConfigAction>
    <ConfigAction label={t('desktopAccess.blocklist')} action={t('config.blockAction')}>
      {native ? <AppPermissions manage/> : <p>{t('config.nativeOnly')}</p>}
    </ConfigAction>
    <FieldRow label={t('desktop.observe')} hint={t(!native ? 'config.nativeOnly' : meeting.state !== 'active' ? 'computer.requiresBoot' : 'desktop.observeHint')}>
      <Switch title={t('desktop.observe')} on={granted && !!status?.desktopAllowed} disabled={disabled || meeting.state !== 'active'} onChange={on => {
        if (on && !granted) openDesktopAccessGuide();
        else void setDesktopObservation(on);
      }}/>
    </FieldRow>
    <FieldRow label={t('desktop.react')} hint={t('desktop.reactHint')}>
      <Switch title={t('desktop.react')} on={!!(status?.proactive && status.reactions)} disabled={disabled || meeting.attention.focus} onChange={on => void configure(on)}/>
    </FieldRow>
    {(failed || error) && <p role="alert">{t('permissions.error')}</p>}
  </>;
}
