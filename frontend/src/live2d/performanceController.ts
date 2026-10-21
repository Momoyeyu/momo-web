import { ParameterMixer } from "./parameterMixer";
import type { ExpressionDefinition, PerformanceCue } from "./performanceTypes";

export interface PerformanceTrace { cue: string; result: string; at: number }
/** Lifecycle policy inspired by AIRI's expression context (MIT); see THIRD_PARTY_NOTICES.md. */
export class PerformanceController {
  state: { name: string | null; intensity: number } = { name: null, intensity: 0 };
  readonly trace: PerformanceTrace[] = [];
  private turnId: string | null = null;
  private preview = false;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private release: ReturnType<typeof setTimeout> | undefined;
  private motionSequence = 0;
  private faceGeneration = 0;
  constructor(private definitions: ExpressionDefinition[], readonly mixer: ParameterMixer,
    private play: (id: string) => Promise<boolean>) {}
  record(cue: string, result: string): string {
    this.trace.push({ cue, result, at: performance.now() });
    if (this.trace.length > 50) this.trace.shift();
    return result;
  }
  beginTurn(id: string): void { this.turnId = id; clearTimeout(this.release); }
  endTurn(id: string): void {
    if (id !== this.turnId || this.preview) return;
    clearTimeout(this.release);
    const generation = this.faceGeneration;
    this.release = setTimeout(() => { if (generation === this.faceGeneration) this.face(null); }, 1200);
  }
  private face(request: PerformanceCue["expression"]): boolean {
    const definition = request ? this.definitions.find((d) => d.name === request.name) : null;
    if (request && !definition) return false;
    clearTimeout(this.expiry); clearTimeout(this.release); this.faceGeneration++;
    const intensity = request ? Math.max(0, Math.min(1, request.intensity)) : 0;
    this.state = { name: request?.name ?? null, intensity };
    this.mixer.set(definition ?? null, intensity, performance.now());
    if (request?.duration !== undefined) {
      const generation = this.faceGeneration;
      this.expiry = setTimeout(() => { if (generation === this.faceGeneration) this.face(null); }, request.duration * 1000);
    }
    return true;
  }
  apply(cue: PerformanceCue, turnId: string): string {
    if (turnId !== this.turnId) return this.record(cue.id, "stale-turn");
    if (this.preview) return this.record(cue.id, "skipped-preview");
    let result = "applied";
    if ("expression" in cue && !this.face(cue.expression)) result = "unknown-expression";
    if (cue.motion) this.motion(cue.motion, cue.id);
    return this.record(cue.id, result);
  }
  private motion(id: string, cueId: string): void {
    const seq = ++this.motionSequence;
    void this.play(id).then((played) => {
      if (seq === this.motionSequence) this.record(cueId, played ? "motion-applied" : "motion-rejected");
    }, () => { if (seq === this.motionSequence) this.record(cueId, "motion-failed"); });
  }
  get previewActive(): boolean { return this.preview; }
  beginPreview(): void { this.preview = true; clearTimeout(this.expiry); clearTimeout(this.release); this.faceGeneration++; }
  previewExpression(name: string | null): void { this.beginPreview(); this.face(name ? { name, intensity: 1 } : null); }
  previewMotion(id: string): void { this.beginPreview(); this.motion(id, "preview"); }
  endPreview(): void { if (!this.preview) return; this.preview = false; this.motionSequence++; this.face(null); }
  cancel(): void {
    this.turnId = null; this.preview = false; this.motionSequence++;
    this.face(null); this.mixer.clear();
  }
}
