import {useId} from 'react';
import {useT} from '../../i18n';
import Button from '../../ui/Button';
import Icon from '../../ui/Icon';
import type {IconName} from '../../ui/icons';

export type ProbeState = 'idle' | 'running' | 'passed' | 'failed' | 'unavailable';

const icons = {running: 'progress', passed: 'check', failed: 'close', unavailable: 'warning'} as const;

export default function ProbeButton({label, idleIcon, state, detail, onClick}: {
  label: string;
  idleIcon: IconName;
  state: ProbeState;
  detail?: string;
  onClick: () => void;
}) {
  const t = useT();
  const statusId = useId();
  const result = state === 'idle' ? '' : detail || t('settings.probe.' + state);
  const blocked = state === 'running' || state === 'unavailable';

  return <>
    <Button className="icon-btn probe-btn tip tip-r" data-probe-state={state} data-tip={result || label}
      aria-label={label} aria-describedby={result ? statusId : undefined}
      aria-disabled={blocked || undefined} aria-busy={state === 'running' || undefined}
      sound={false} onClick={event => {if (!blocked) onClick(); else event.preventDefault();}}>
      <Icon name={state === 'idle' ? idleIcon : icons[state]}/>
    </Button>
    <span className="probe-announcement" id={statusId} role="status">{result}</span>
  </>;
}
