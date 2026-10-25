import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { loadTranscript, getChatEngine, subscribeTranscript, transcriptVersion } from '../chat/engineInstance';
import { getStage } from '../live2d/stage';
import { getState, update, resyncPassthrough } from '../lib/store';
import { liveTranscript } from '../services/lifeClient';
import { firstMeetingStatus, type FirstMeetingStatus } from '../services/onboardingClient';
import { putState } from '../services/stateClient';
import { apiJson } from '../services/http';
import { probeLlm } from '../services/probe';
import { navigate } from '../router';
import type { PersistedState } from '../lib/types';
import { useT } from '../i18n';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Hint from '../ui/Hint';
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
  const [helpOpen, setHelpOpen] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const leave = () => { if (!/^#\/?chat$/.test(location.hash)) pending.current?.abort(); };
    window.addEventListener('hashchange', leave);
    return () => { pending.current?.abort(); window.removeEventListener('hashchange', leave); };
  }, []);
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
      if ((next.stage !== 'new' && !next.pendingOpening) || !next.configured) return;
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
    const request = new AbortController();
    pending.current?.abort();pending.current = request;
    const current = () => pending.current === request && !request.signal.aborted && /^#\/?chat$/.test(location.hash);
    setBusy(true); setError('');
    try {
      const url = new URL(draft.url.trim());
      if (!['http:', 'https:'].includes(url.protocol) || !draft.model.trim()) throw new Error();
      const llm = {...draft, url: draft.url.trim(), key: draft.key.trim(), model: draft.model.trim()};
      const health = await probeLlm(llm, request.signal);
      if (!current()) return;
      if (!health.ok) {
        setError(t('meeting.modelConnectionError').replace('{detail}', /^HTTP \d{3}$/.test(health.detail) ? ` (${health.detail})` : ''));
        return;
      }
      // Read / preserve passthrough state, and await durable settings before opening.
      const latest = await apiJson<Partial<PersistedState>>('/api/state', {signal:request.signal});
      if (!current()) return;
      if (!latest || typeof latest !== 'object' || Array.isArray(latest)) throw new Error();
      const settings = {...(latest.settings ?? getState().settings), llm};
      if (!await putState({...getState(), ...latest, settings}, request.signal)) throw new Error();
      if (!current()) return;
      update({settings});
      await resyncPassthrough();
      if (!current()) return;
      setSetup(false); setRetry(n => n + 1);
    } catch { if (current()) setError(t('meeting.connectionError')); }
    finally { if (current()) setBusy(false); if (pending.current === request) pending.current = null; }
  };
  const close = () => {
    if (busy) return;
    setSetup(false);
    if (!status?.configured) navigate('title');
  };
  const active = status && ['new', 'asking', 'clarifying'].includes(status.stage);
  return <>
    {setup && <Modal label={t('meeting.connectTitle')} className="first-meeting-setup" onClose={close}>
      <h2>{t('meeting.connectTitle')} <button type="button" className="hint first-meeting-help-toggle" aria-label={t('meeting.helpLabel')} aria-expanded={helpOpen} aria-controls="first-meeting-help" onClick={() => setHelpOpen(open => !open)}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
      </button></h2>
      <div id="first-meeting-help" className="first-meeting-help muted" hidden={!helpOpen}>
        <p>{t('meeting.connectBody')}</p>
        <p>{t('meeting.connectionHint')}</p>
        <p className="first-meeting-provider">{t('meeting.providerLead')}<a href="https://platform.deepseek.com/" target="_blank" rel="noopener noreferrer">{t('meeting.providerLink')}</a></p>
      </div>
      <form onSubmit={e => {e.preventDefault(); void save();}}>
        {(['url', 'key', 'model'] as const).map(field => <div key={field} className="first-meeting-field">
          <span className="first-meeting-field-label"><label htmlFor={`first-meeting-${field}`}>{t(`meeting.${field}`)}</label><Hint text={t(`meeting.${field}Hint`)} /></span>
          <input id={`first-meeting-${field}`} type={field === 'key' ? 'password' : field === 'url' ? 'url' : 'text'} required={field !== 'key'}
            autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={draft[field]} disabled={busy}
            onChange={e => setDraft({...draft, [field]: e.target.value})} />
        </div>)}
        {error && <p role="alert" className="first-meeting-error">{error}</p>}
        <div className="modal-foot"><Button variant="ghost" disabled={busy} onClick={close}>{t("common.cancel")}</Button><Button type="submit" disabled={busy}>{busy ? t('meeting.checking') : t('meeting.begin')}</Button></div>
      </form>
    </Modal>}
    {active && (!status.configured || connectionFailed) && !setup && <Button className="first-meeting-connect" size="sm" variant="ghost" onClick={() => setSetup(true)}>{t('meeting.connectionSettings')}</Button>}
  </>;
}
