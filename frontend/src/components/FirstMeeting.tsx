import { useEffect, useState, useSyncExternalStore } from 'react';
import { loadTranscript, getChatEngine, subscribeTranscript, transcriptVersion } from '../chat/engineInstance';
import { getStage } from '../live2d/stage';
import { getState, update, resyncPassthrough } from '../lib/store';
import { liveTranscript } from '../services/checkpointClient';
import { firstMeetingStatus, type FirstMeetingStatus } from '../services/onboardingClient';
import { putState } from '../services/stateClient';
import { apiJson } from '../services/http';
import type { PersistedState } from '../lib/types';
import { useT } from '../i18n';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import '../styles/onboarding.css';

/** Small connection gate; the actual first meeting happens on the chat stage. */
export default function FirstMeeting({connectionFailed = false}: {connectionFailed?: boolean}) {
  const t = useT();
  const version = useSyncExternalStore(subscribeTranscript, transcriptVersion);
  const [status, setStatus] = useState<FirstMeetingStatus | null>(null);
  const [setup, setSetup] = useState(false);
  const [draft, setDraft] = useState({...getState().settings.llm});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const next = await firstMeetingStatus();
      if (cancelled || !next) return;
      setStatus(next);
      if (next.stage === 'new' && !next.configured) setSetup(true);
      if (['asking', 'clarifying'].includes(next.stage) && !getChatEngine().history.length) {
        const live = await liveTranscript().catch(() => null);
        if (!cancelled && live?.messages.length) loadTranscript(live.messages);
      }
      if (next.stage !== 'new' || !next.configured) return;
      // Use the actual loaded catalog, never guessed resource names.
      const deadline = Date.now() + 6000;
      const begin = () => {
        if (cancelled) return;
        if (getChatEngine().status !== 'idle') return;
        if (!getStage().getPresentation() && Date.now() < deadline) { timer = setTimeout(begin, 200); return; }
        getChatEngine().beginFirstMeeting();
      };
      begin();
    };
    // Do not fetch on every revealed character, only when the engine settles.
    if (getChatEngine().status === 'idle') void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [version, retry]);

  const save = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const url = new URL(draft.url.trim());
      if (!['http:', 'https:'].includes(url.protocol) || !draft.model.trim()) throw new Error();
      // Read / preserve passthrough state, and await durable settings before opening.
      const latest = await apiJson<Partial<PersistedState>>('/api/state');
      if (!latest || typeof latest !== 'object' || Array.isArray(latest)) throw new Error();
      const settings = {...(latest.settings ?? getState().settings), llm: {...draft, url: draft.url.trim(), model: draft.model.trim()}};
      if (!await putState({...getState(), ...latest, settings})) throw new Error();
      update({settings});
      await resyncPassthrough();
      setSetup(false); setRetry(n => n + 1);
    } catch { setError(t('meeting.connectionError')); }
    finally { setBusy(false); }
  };
  const active = status && ['new', 'asking', 'clarifying'].includes(status.stage);
  return <>
    {setup && <Modal label={t('meeting.connectTitle')} className="first-meeting-setup" onClose={() => { if (!busy) setSetup(false); }}>
      <h2>{t('meeting.connectTitle')}</h2>
      <p className="muted">{t('meeting.connectBody')}</p>
      <form onSubmit={e => {e.preventDefault(); void save();}}>
        {(['url', 'key', 'model'] as const).map(field => <label key={field}>
          <span>{t(`meeting.${field}`)}</span>
          <input type={field === 'key' ? 'password' : field === 'url' ? 'url' : 'text'} required={field !== 'key'}
            autoComplete="off" value={draft[field]} disabled={busy}
            onChange={e => setDraft({...draft, [field]: e.target.value})} />
        </label>)}
        {error && <p role="alert" className="first-meeting-error">{error}</p>}
        <div className="modal-foot"><Button variant="ghost" disabled={busy} onClick={() => setSetup(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={busy}>{busy ? '…' : t('meeting.begin')}</Button></div>
      </form>
    </Modal>}
    {active && (!status.configured || connectionFailed) && !setup && <Button className="first-meeting-connect" size="sm" variant="ghost" onClick={() => setSetup(true)}>{t('meeting.connectionSettings')}</Button>}
  </>;
}
