import {useState, type ReactNode} from 'react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import FieldRow from '../../ui/FieldRow';
import DialogBackButton from '../../ui/DialogBackButton';

export default function ConfigAction({label, action, actionLabel, value, model, children}: {
  label: string; action: string; actionLabel?: string; value?: string; model?: 'LLM' | 'TTS'; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const trigger = <Button variant="ghost" className="config-action" aria-label={actionLabel} onClick={() => setOpen(true)}>{action}</Button>;
  return <>
    {model ? <div className="config-model-row">
      <b>{model}</b><span>{label}</span><span className="config-value" title={value}>{value}</span>{trigger}
    </div> : <FieldRow label={label}>
      {value && <span className="config-value">{value}</span>}
      {trigger}
    </FieldRow>}
    {open && <Modal label={label} className="config-modal" onClose={close}>
      <header className="config-modal-head"><DialogBackButton onClick={close}/><h2>{label}</h2></header>
      <div className="config-modal-body">{children}</div>
    </Modal>}
  </>;
}
