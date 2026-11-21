import {useState, type ReactNode} from 'react';
import Modal from '../../ui/Modal';
import FieldRow from '../../ui/FieldRow';
import DialogBackButton from '../../ui/DialogBackButton';
import IconButton from '../../ui/IconButton';
import type {IconName} from '../../ui/icons';

export default function ConfigAction({label, action, icon = 'gear', value, model, children}: {
  label: string; action: string; icon?: IconName; value?: string; model?: 'LLM' | 'TTS'; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const trigger = <IconButton icon={icon} label={action} tip={action} sound="tap" onClick={() => setOpen(true)}/>;
  return <>
    {model ? <div className="config-model-row">
      <b>{model}</b><span>{label}</span><span className="config-value" title={value}>{value}</span>{trigger}
    </div> : <FieldRow label={label}>
      {value && <span className="config-value" title={value}>{value}</span>}
      {trigger}
    </FieldRow>}
    {open && <Modal label={label} className="config-modal" onClose={close}>
      <header className="config-modal-head"><DialogBackButton onClick={close}/><h2>{label}</h2></header>
      <div className="config-modal-body">{children}</div>
    </Modal>}
  </>;
}
