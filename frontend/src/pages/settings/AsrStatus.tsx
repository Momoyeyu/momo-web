import {useEffect, useState} from 'react';
import {useT} from '../../i18n';
import {apiJson} from '../../services/http';
import Button from '../../ui/Button';

type Status = {ready: boolean; engine: string; language: string; missing: string[]};
export default function AsrStatus() {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError(false);
    void apiJson<{asr: Status}>('/api/resources/status', {signal: abort.signal})
      .then(({asr}) => {if (!abort.signal.aborted) setStatus(asr);})
      .catch(() => {if (!abort.signal.aborted) setError(true);});
    return () => abort.abort();
  }, [attempt]);
  if (error) return <p role="alert">{t('config.unavailable')} <Button onClick={() => setAttempt(v => v + 1)}>{t('meeting.retry')}</Button></p>;
  if (!status) return <p role="status">{t('config.loading')}</p>;
  return <><p>{status.engine} · {status.language}</p>
    <p role="status">{t(status.ready ? 'config.ready' : 'settings.builtinSpeechUnavailable')}</p>
    {!!status.missing?.length && <p>{status.missing.join(', ')}</p>}</>;
}
