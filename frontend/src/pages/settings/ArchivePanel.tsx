import {useEffect, useState} from 'react';
import {useT} from '../../i18n';
import type {components} from '../../api/schema';
import {apiJson} from '../../services/http';
import Backlog from '../Backlog';

type Archive = components['schemas']['CheckpointMeta'];
type Detail = components['schemas']['CheckpointDetail'];

/** v3 has a single live history. Migrated checkpoints remain readable in place. */
export default function ArchivePanel() {
  const t = useT();
  const [archives, setArchives] = useState<Archive[]>([]);
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState<Detail | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setError(false);
    if (selected) {
      void apiJson<Detail>('/api/checkpoints/' + encodeURIComponent(selected), {signal: abort.signal})
        .then(value => {if (!abort.signal.aborted) setLoaded(value);})
        .catch(() => {if (!abort.signal.aborted) setError(true);});
    } else {
      void apiJson<Archive[]>('/api/checkpoints', {signal: abort.signal})
        .then(value => {if (!abort.signal.aborted) setArchives(value);})
        .catch(() => {if (!abort.signal.aborted) setError(true);});
    }
    return () => abort.abort();
  }, [selected]);
  return <>
    {archives.length > 0 && <select className="extension-window-select" aria-label={t('config.history')} value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">{t('backlog.title')}</option>
      {archives.map(item => <option key={item.id} value={item.id}>{item.title || item.updatedAt}</option>)}
    </select>}
    {error && <p role="alert">{t('backlog.loadFailed')}</p>}
    {!selected ? <Backlog embedded/> : loaded?.id === selected ? <>
      {loaded.summary && <p>{loaded.summary}</p>}
      {loaded.messages.map((message,index) => <p key={index}><strong>{message.role === 'user' ? t('chat.you') : 'momo'}</strong> · {message.text}</p>)}
    </> : !error && <p role="status">{t('config.loading')}</p>}
  </>;
}
