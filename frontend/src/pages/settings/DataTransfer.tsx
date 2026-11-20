import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import Button from '../../ui/Button';
import Confirm from '../../ui/Confirm';
import FieldRow from '../../ui/FieldRow';
import '../../styles/modal.css';
import '../../styles/data-transfer.css';
import {useT} from '../../i18n';
import {pausePersistence} from '../../lib/store';
import {exportData, importData} from '../../services/dataTransfer';
type Operation = 'export' | 'restore';
type TransferState = {busy: Operation | null; error: Operation | null};

// History navigation can remount Settings while a snapshot or restore is in flight.
let transfer: TransferState = {busy: null, error: null};
const listeners = new Set<() => void>();
const getTransfer = () => transfer;
function subscribeTransfer(listener: () => void) {
  listeners.add(listener);
  return () => {listeners.delete(listener);};
}
function publishTransfer(next: TransferState) {
  transfer = next;
  listeners.forEach(listener => listener());
}

async function runTransfer(operation: Operation, action: () => Promise<void>) {
  if (transfer.busy) return;
  publishTransfer({busy: operation, error: null});
  let resume: (() => void) | undefined;
  let reloading = false;
  let error: Operation | null = null;
  try {
    resume = await pausePersistence();
    await action();
    if (operation === 'restore') {
      location.reload();
      reloading = true;
    }
  } catch {
    error = operation;
  } finally {
    if (!reloading) {
      resume?.();
      publishTransfer({busy: null, error});
    }
  }
}

export default function DataTransfer() {
  const t = useT();
  const [pendingRestore, setPendingRestore] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const busyDialog = useRef<HTMLDialogElement>(null);
  const {busy, error} = useSyncExternalStore(subscribeTransfer, getTransfer);
  useEffect(() => {
    const dialog = busyDialog.current;
    if (!busy || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => dialog.close();
  }, [busy]);

  return <>
    <FieldRow label={t('config.backup')} hint={t('config.backupHint')}>
      <Button className="config-action" variant="ghost" disabled={busy !== null} onClick={() => void runTransfer('export', async () => {
        const url = URL.createObjectURL(await exportData());
        const a = document.createElement('a');
        a.href = url;
        a.download = 'momo-backup.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })}>{busy === 'export' ? t('config.backupWorking') : t('config.backupAction')}</Button>
    </FieldRow>
    <FieldRow label={t('config.restore')}>
      <Button className="config-action" variant="ghost" disabled={busy !== null} onClick={() => input.current?.click()}>{t('config.restoreAction')}</Button>
      <input ref={input} hidden type="file" accept=".zip" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (file && !transfer.busy) setPendingRestore(file);
      }}/>
    </FieldRow>
    {pendingRestore && <Confirm title={t('config.restore')} message={pendingRestore.name + ' · ' + t('config.restoreConfirm')}
      confirmLabel={t('config.restore')} danger onCancel={() => setPendingRestore(null)} onConfirm={() => {
        setPendingRestore(null);
        void runTransfer('restore', () => importData(pendingRestore));
      }}/>}
    {busy && <dialog ref={busyDialog} className="modal-box data-transfer-busy" aria-label={t(busy === 'restore' ? 'config.restore' : 'config.backup')}
      onCancel={event => event.preventDefault()}>
      <p role="status" aria-live="polite">{t('config.backupWorking')}</p>
    </dialog>}
    {error && <p className="data-transfer-error" role="alert">{t(error === 'restore' ? 'config.restoreError' : 'config.backupError')}</p>}
  </>;
}
