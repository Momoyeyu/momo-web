import {useEffect, useState, useSyncExternalStore} from 'react';
import {useT} from '../i18n';
import {computerSnapshot, subscribeComputer, configureComputer, readComputer} from '../services/computerClient';
import {meetingSnapshot, subscribeMeeting} from '../services/meetingClient';
import Button from '../ui/Button';
import Icon from '../ui/Icon';
import FieldRow from '../ui/FieldRow';
import Switch from '../ui/Switch';

/** Settings, Chat, and the desktop pet use the same stored preference. */
export default function ProactiveResponseToggle({placement = 'toolbar'}: {placement?: 'toolbar' | 'settings'}) {
  const t = useT();
  const {status} = useSyncExternalStore(subscribeComputer, computerSnapshot);
  const {attention} = useSyncExternalStore(subscribeMeeting, meetingSnapshot);
  const inSettings = placement === 'settings';
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const enabled = !!(status?.proactive && status.reactions);
  const disabled = saving || !status || (!inSettings && attention.focus);
  const label = t('chat.proactive');
  const description = t(failed ? 'chat.proactiveError' : 'chat.proactiveHint');

  useEffect(() => {
    if (inSettings) void readComputer().catch(() => setFailed(true));
  }, [inSettings]);

  async function setEnabled(on: boolean) {
    if (disabled) return;
    setSaving(true);
    setFailed(false);
    try { await configureComputer(on, on); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  }

  if (inSettings) return <FieldRow label={label} hint={description}>
    <Switch title={label} on={enabled} disabled={disabled} onChange={on => void setEnabled(on)}/>
    {failed && <span className="config-value" role="alert">{description}</span>}
  </FieldRow>;

  return <Button className={`tb tb-proactive tip${enabled ? ' is-active' : ''}`} aria-label={label} aria-pressed={enabled}
    data-tip={label} data-tip-detail={description} disabled={disabled} onClick={() => void setEnabled(!enabled)}>
    <Icon name="proactive"/>
  </Button>;
}
