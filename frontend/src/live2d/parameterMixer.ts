import type { ExpressionDefinition, ParameterCore } from "./performanceTypes";

/** Expression contributions are computed from the SDK's fresh frame, never accumulated. */
export class ParameterMixer {
  private from: { definition: ExpressionDefinition; weight: number }[] = [];
  private target: { definition: ExpressionDefinition; weight: number }[] = [];
  private started = 0;
  private weights(now: number) {
    const t = Math.max(0, Math.min(1, (now - this.started) / 250));
    const eased = t * t * (3 - 2 * t);
    return [...this.from.map((x) => ({ ...x, weight: x.weight * (1 - eased) })),
      ...this.target.map((x) => ({ ...x, weight: x.weight * eased }))].filter((x) => x.weight > 0);
  }
  set(definition: ExpressionDefinition | null, intensity: number, now: number): void {
    this.from = this.weights(now);
    this.target = definition ? [{ definition, weight: intensity }] : [];
    this.started = now;
  }
  clear(): void { this.from = []; this.target = []; }
  apply(core: ParameterCore, now: number, face?: { eyes: string[]; blink: number; mouthId?: string; mouth: number; mouthWeight?: number }): void {
    const contributions = new Map<string, number>();
    for (const { definition, weight } of this.weights(now)) {
      for (const p of definition.parameters) {
        const base = core.getParameterValueById(p.id);
        const target = p.blend === "Add" ? base + p.value : p.blend === "Multiply" ? base * p.value : p.value;
        contributions.set(p.id, (contributions.get(p.id) ?? 0) + (target - base) * weight);
      }
    }
    for (const [id, value] of contributions) core.setParameterValueById(id, core.getParameterValueById(id) + value);
    if (face) {
      for (const id of face.eyes) core.setParameterValueById(id, core.getParameterValueById(id) * face.blink);
      if (face.mouthId) {
        const weight = face.mouthWeight ?? 1;
        const base = core.getParameterValueById(face.mouthId);
        core.setParameterValueById(face.mouthId, base + (face.mouth - base) * weight);
      }
    }
  }
}
