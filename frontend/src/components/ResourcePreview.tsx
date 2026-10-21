import { useEffect, useRef, useState } from "react";
import { getStage } from "../live2d/stage";
import type { PreviewPlayback } from "../live2d/previewPlayback";
import type { PresentationSnapshot } from "../live2d/performanceTypes";
import { useT } from "../i18n";
import Button from "../ui/Button";

export interface ResourceSelection { kind: "expressions" | "motions"; name: string; request: number }

/** Borrows the application canvas; never creates a second renderer or ticker. */
export default function ResourcePreview({ avatarId, selection, onReady }: {
  avatarId: string;
  selection: ResourceSelection | null;
  onReady: (snapshot: PresentationSnapshot | null) => void;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"raw" | "composed">("raw");
  const [closeUp, setCloseUp] = useState(true);
  const [snapshot, setSnapshot] = useState<PresentationSnapshot | null>(null);
  const [playback, setPlayback] = useState<PreviewPlayback | null>(null);
  const [trace, setTrace] = useState<string[]>([]);

  useEffect(() => {
    if (!host.current) return;
    const stage = getStage();
    let alive = true;
    let loaded = false;
    setReady(false); setFailed(false); setCloseUp(true); setMode("raw");
    onReady(null);
    const lease = stage.openResourcePreview(host.current, avatarId);
    void lease.ready.then(() => {
      if (!alive) return;
      loaded = true;
      setReady(true);
      onReady(stage.getPresentation(true));
    }, () => { if (alive) setFailed(true); });
    const timer = setInterval(() => {
      if (!loaded) return;
      setSnapshot(stage.getPresentation(true));
      setPlayback(stage.getPreviewPlayback());
      setTrace(stage.getPerformanceTrace().slice(-5).map(x => `${x.cue} · ${x.result}`));
    }, 100);
    return () => { alive = false; clearInterval(timer); onReady(null); lease.release(); };
  }, [avatarId, onReady]);

  useEffect(() => {
    if (!ready || !selection) return;
    const stage = getStage();
    stage.setPreviewMode(mode);
    if (selection.kind === "expressions") stage.previewExpression(selection.name);
    else stage.previewMotion(selection.name);
    setPlayback(stage.getPreviewPlayback());
  }, [ready, selection, mode]);

  return <aside className="resource-preview" aria-label={t("performance.preview")}>
    <div className="resource-preview-caption">
      <span>{t("performance.face")}</span>
      <strong data-testid="performance-face">{snapshot?.expressionState.name ?? t("performance.neutral")}</strong>
    </div>
    <div className="resource-preview-viewport" ref={host}>
      {(!ready || failed) && <p className="resource-preview-message" role="status">{t(failed ? "performance.unavailable" : "performance.loading")}</p>}
      <div className="resource-preview-progress" role="progressbar" aria-label={t("performance.progress")}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor((playback?.progress ?? 0) * 100)}
        data-state={playback?.phase ?? "idle"}>
        <span style={{ transform: `scaleX(${playback?.progress ?? 0})` }} />
      </div>
    </div>
    <div className="resource-preview-controls">
      {(["raw", "composed"] as const).map(value => <Button key={value} size="sm" variant="ghost" disabled={!ready}
        aria-pressed={mode === value} onClick={() => setMode(value)}>{t(`performance.${value}`)}</Button>)}
      <Button size="sm" variant="ghost" disabled={!ready} onClick={() => { getStage().setCloseUp(!closeUp); setCloseUp(!closeUp); }}>
        {t(closeUp ? "performance.fullBody" : "performance.closeUp")}
      </Button>
      <Button size="sm" variant="ghost" disabled={!ready} onClick={() => { getStage().resetResourcePreview(); setPlayback(null); }}>{t("performance.reset")}</Button>
    </div>
    <p className="resource-preview-hint muted">{t("performance.resourceHint")}</p>
    {import.meta.env.DEV && <details className="resource-preview-trace"><summary>{t("performance.trace")}</summary>{trace.map((item, i) => <div key={i}>{item}</div>)}</details>}
  </aside>;
}
