// Quiet when bundled capabilities are healthy; no extra model configuration.
import { useEffect, useState } from "react";
import { apiJson } from "../services/http";
import { useT } from "../i18n";
import FieldRow from "../ui/FieldRow";
import Button from "../ui/Button";

interface ResourceStatus {
  asr: { ready: boolean; engine: string; language: string; missing: string[] };
  embedding: { state: string };
  index: { state: string };
}
export default function BuiltinResourcesNotice({showSpeech = false}: {showSpeech?: boolean}) {
  const t = useT();
  const [status, setStatus] = useState<ResourceStatus | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setError(false);
    void apiJson<ResourceStatus>("/api/resources/status", {signal: ctl.signal})
      .then(value => {
        if (ctl.signal.aborted) return;
        if (value?.asr && value.embedding && value.index) setStatus(value);
        else setError(true);
      })
      .catch(() => { if (!ctl.signal.aborted) setError(true); });
    return () => ctl.abort();
  }, [attempt]);
  const messages = [];
  const asr = status?.asr;
  if (!showSpeech && asr && !asr.ready) messages.push(t("settings.builtinSpeechUnavailable"));
  if (status && (["missing", "error"].includes(status.embedding.state) || status.index.state === "degraded")) {
    messages.push(t("settings.builtinRecallUnavailable"));
  }
  return <>
    {showSpeech && <div className="asr-status">
      <FieldRow label={t('config.asr')}>
        {asr && <span className="config-value">{asr.engine} · {asr.language}</span>}
        <span className="config-value" role={error ? 'alert' : 'status'}>
          {t(error ? 'config.unavailable' : !asr ? 'config.loading' : asr.ready ? 'config.ready' : 'settings.builtinSpeechUnavailable')}
        </span>
        {error && <Button variant="ghost" size="sm" onClick={() => setAttempt(v => v + 1)}>{t('meeting.retry')}</Button>}
      </FieldRow>
      {!!asr?.missing?.length && <p className="config-value">{asr.missing.join(', ')}</p>}
    </div>}
    {messages.length > 0 && <div className="builtin-resource-notice" role="status">{messages.map(text => <p key={text}>{text}</p>)}</div>}
  </>;
}
