// Quiet when bundled capabilities are healthy; no extra model configuration.
import { useEffect, useState } from "react";
import { apiJson } from "../services/http";
import { useT } from "../i18n";

interface ResourceStatus {
  asr: { ready: boolean };
  embedding: { state: string };
  index: { state: string };
}
export default function BuiltinResourcesNotice() {
  const t = useT();
  const [status, setStatus] = useState<ResourceStatus | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    void apiJson<ResourceStatus>("/api/resources/status", {signal: ctl.signal})
      .then(value => { if (!ctl.signal.aborted && value?.asr && value.embedding && value.index) setStatus(value); })
      .catch(() => {}); // Connection errors are reported by the service controls.
    return () => ctl.abort();
  }, []);
  if (!status) return null;
  const messages = [];
  if (!status.asr.ready) messages.push(t("settings.builtinSpeechUnavailable"));
  if (["missing", "error"].includes(status.embedding.state) || status.index.state === "degraded") {
    messages.push(t("settings.builtinRecallUnavailable"));
  }
  if (!messages.length) return null;
  return <div className="builtin-resource-notice" role="status">{messages.map(text => <p key={text}>{text}</p>)}</div>;
}
