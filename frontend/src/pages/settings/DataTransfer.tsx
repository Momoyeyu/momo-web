import {useEffect, useRef, useState} from 'react';
import Button from '../../ui/Button';
import '../../styles/modal.css';
import '../../styles/data-transfer.css';
import {useSyncExternalStore} from 'react';
import {getState, subscribe, pausePersistence} from '../../lib/store';
import {exportData, importData} from '../../services/dataTransfer';
const labels = {
  zh: ['数据备份', '导出备份', '恢复备份', '备份包含聊天、记忆、模型和服务密钥，请妥善保管。恢复会替换当前数据。', '确定恢复备份并替换当前数据？', '操作失败，请检查备份文件后重试。', '处理中…'],
  en: ['Data backup', 'Export backup', 'Restore backup', 'Backups contain chats, memories, models and service keys. Keep them private. Restoring replaces current data.', 'Restore this backup and replace current data?', 'Could not complete the operation. Check the backup and retry.', 'Working…'],
  ja: ['データのバックアップ', '書き出す', '復元する', 'バックアップには会話、記憶、モデル、サービスキーが含まれます。安全に保管してください。復元すると現在のデータが置き換わります。', '現在のデータをバックアップで置き換えますか？', '操作に失敗しました。ファイルを確認して再試行してください。', '処理中…'],
};
export default function DataTransfer() {
  const lang = useSyncExternalStore(subscribe, getState).settings.general.lang;
  const text = labels[lang];
  const input = useRef<HTMLInputElement>(null);
  const busyDialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const dialog = busyDialog.current;
    if (!dialog) return;
    if (busy && !dialog.open) dialog.showModal();
    else if (!busy && dialog.open) dialog.close();
  }, [busy]);
  async function run(action: () => Promise<void>, reload = false) {
    setBusy(true); setError(false);
    let resume: (() => void) | undefined;
    let completed = false;
    try {
      resume = await pausePersistence();
      await action(); completed = true;
      if (reload) location.reload();
    } catch { setError(true); } finally {
      if (!reload || !completed) resume?.();
      setBusy(false);
    }
  }
  return <section className="panel data-transfer-panel">
    <div className="data-transfer-copy"><h3 className="opt-group">{text[0]}</h3><p>{text[3]}</p></div>
    <div className="data-transfer-actions">
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(async () => {
      const blob = await exportData(); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'momo-backup.zip'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    })}>{text[1]}</Button>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => input.current?.click()}>{text[2]}</Button>
    </div>
    <input ref={input} hidden type="file" accept=".zip" onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file && confirm(text[4])) void run(() => importData(file), true);
    }}/>
    <dialog ref={busyDialog} className="modal-box data-transfer-busy" aria-label={text[0]}
      onCancel={event => event.preventDefault()}>
      <p role="status" aria-live="polite">{text[6]}</p>
    </dialog>
    {error && <p className="data-transfer-error" role="alert">{text[5]}</p>}
  </section>;
}
