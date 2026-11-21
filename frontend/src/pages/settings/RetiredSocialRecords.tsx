import {useId, useRef, useState} from 'react';
import {useT} from '../../i18n';
import {endRetiredSocialWait, type RetiredSocialRecord} from '../../services/socialClient';
import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import DialogBackButton from '../../ui/DialogBackButton';
import Modal from '../../ui/Modal';

export default function RetiredSocialRecords({records, onChanged, onClose}: {
  records: RetiredSocialRecord[];
  onChanged: (records: RetiredSocialRecord[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const working = useRef(false);
  const confirmationId = useId();
  const selectedRecord = records.find(record => record.commandId === selected);

  function select(id: string | null) {
    if (working.current) return;
    setSelected(id);
    setConfirmed(false);
    setError(false);
  }

  async function endWait(commandId: string) {
    if (working.current || !confirmed || selected !== commandId) return;
    working.current = true;
    setPending(true);
    setError(false);
    try {
      const remaining = await endRetiredSocialWait(commandId);
      setSelected(null);
      setConfirmed(false);
      onChanged(remaining);
    } catch {
      setError(true);
    } finally {
      working.current = false;
      setPending(false);
    }
  }

  return <>
    <Modal className="extension-modal social-retired-records" label={t('social.retiredLibrary')} onClose={() => {
      if (!working.current) onClose();
    }}>
      <header className="settings-dialog-heading">
        <DialogBackButton onClick={onClose} disabled={pending}/>
        <h2>{t('social.retiredLibrary')}</h2>
      </header>
      <p className="social-help muted">{t(records.length ? 'social.retiredHint' : 'social.noRecords')}</p>
      {records.map(record => <article className="social-record" key={record.commandId}>
        <div className="social-record-top">
          <strong>{t('social.retiredSource')}</strong><span>{t('social.delivery.unknown')}</span>
        </div>
        <dl className="social-retired-metadata">
          <div><dt>{t('social.retiredAccount')}</dt><dd>{record.accountId || t('social.retiredMetadataMissing')}</dd></div>
          <div><dt>{t('social.retiredPeer')}</dt><dd>{record.peerId || t('social.retiredMetadataMissing')}</dd></div>
        </dl>
        <code>{record.commandId}</code><time dateTime={record.createdAt}>{record.createdAt}</time>
        <div className="extension-detail-actions">
          <Button variant="ghost" onClick={() => select(record.commandId)}>{t('social.retiredHandle')}</Button>
        </div>
      </article>)}
    </Modal>
    {selectedRecord && <Modal className="confirm-box retired-wait-confirm" label={t('social.endRetiredWait')} onClose={() => select(null)}>
      <h2 className="confirm-title">{t('social.endRetiredWait')}</h2>
      <p className="confirm-subject">{selectedRecord.peerId || selectedRecord.commandId}</p>
      <p className="confirm-text">{t('social.retiredUnknown')}</p>
      <div className="social-retired-confirm">
        <Checkbox id={confirmationId} checked={confirmed} disabled={pending} onChange={event => setConfirmed(event.target.checked)}/>
        <label htmlFor={confirmationId}>{t('social.retiredExecutorStopped')}</label>
      </div>
      {error && <p className="social-error" role="alert">{t('social.retiredEndWaitError')}</p>}
      <div className="modal-foot">
        <Button variant="ghost" disabled={pending} onClick={() => select(null)}>{t('common.cancel')}</Button>
        <Button disabled={pending || !confirmed} onClick={() => void endWait(selectedRecord.commandId)}>
          {t(pending ? 'social.endingRetiredWait' : 'social.endRetiredWait')}
        </Button>
      </div>
    </Modal>}
  </>;
}
