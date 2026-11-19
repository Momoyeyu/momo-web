import {useState, type ReactNode} from 'react';
import {useT} from '../../i18n';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import FieldRow from '../../ui/FieldRow';

export default function ConfigAction({label, action, value, children}: {
  label: string; action: string; value?: string; children?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return <>
    <FieldRow label={label}>
      {value && <span className="config-value">{value}</span>}
      <Button variant="ghost" className="config-action" onClick={() => setOpen(true)}>{action}</Button>
    </FieldRow>
    {open && <Modal label={label} className="config-modal" onClose={close}>
      <header className="config-modal-head"><h2>{label}</h2><button type="button" aria-label={t('common.close')} onClick={close}>×</button></header>
      <div className="config-modal-body">{children}</div>
    </Modal>}
  </>;
}
