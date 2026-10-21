import { describe, expect, it, vi, afterEach } from "vitest";
import { ParameterMixer } from "./parameterMixer";
import { PerformanceController } from "./performanceController";

const happy = { name: "happy", parameters: [
  { id: "eye", value: 0, blend: "Overwrite" as const },
  { id: "cheek", value: 1, blend: "Add" as const },
] };
const curious = { name: "curious", parameters: [{ id: "brow", value: 0.8, blend: "Overwrite" as const }] };
function core() {
  const values: Record<string, number> = { eye: 1, cheek: 0, brow: 0, mouth: 0 };
  return { values, getParameterValueById: (id: string) => values[id] ?? 0,
    setParameterValueById: (id: string, value: number) => { values[id] = value; } };
}
afterEach(() => vi.useRealTimers());

describe("parameter composition", () => {
  it("releases old parameters and never accumulates additive values", () => {
    const mixer = new ParameterMixer(); const model = core();
    mixer.set(happy, 1, 0);
    mixer.apply(model, 250);
    expect(model.values.eye).toBe(0); expect(model.values.cheek).toBe(1);
    model.values.cheek = 0; model.values.eye = 1;
    mixer.apply(model, 500); expect(model.values.cheek).toBe(1);
    mixer.set(curious, 1, 500);
    model.values.cheek = 0; model.values.eye = 1;
    mixer.apply(model, 750);
    expect(model.values.cheek).toBe(0); expect(model.values.eye).toBe(1);
    expect(model.values.brow).toBe(0.8);
  });
  it("interpolates intensity and preserves a closed-eye expression under blinking", () => {
    const mixer = new ParameterMixer(); const model = core();
    mixer.set(happy, 0.5, 0); mixer.apply(model, 250);
    expect(model.values.eye).toBe(0.5);
    mixer.set(happy, 1, 250); model.values.eye = 1;
    mixer.apply(model, 500, { eyes: ["eye"], blink: 0.5, mouthId: "mouth", mouth: 0.7 });
    expect(model.values.eye).toBe(0); expect(model.values.mouth).toBe(0.7);
  });
});

describe("performance lifecycle", () => {
  function make() {
    const mixer = new ParameterMixer();
    const controller = new PerformanceController([happy, curious], mixer, async () => true);
    controller.beginTurn("t"); return controller;
  }
  it("motion-only cues do not cancel expression expiry", async () => {
    vi.useFakeTimers(); const c = make();
    c.apply({ id: "a", offset: 0, expression: { name: "happy", intensity: 1, duration: 0.5 } }, "t");
    await vi.advanceTimersByTimeAsync(200);
    c.apply({ id: "b", offset: 1, motion: "Idle/2" }, "t");
    await vi.advanceTimersByTimeAsync(310);
    expect(c.state.name).toBeNull();
  });
  it("new expressions survive old timers and reply completion uses earlier expiry", async () => {
    vi.useFakeTimers(); const c = make();
    c.apply({ id: "a", offset: 0, expression: { name: "happy", intensity: 1, duration: 0.5 } }, "t");
    await vi.advanceTimersByTimeAsync(200);
    c.apply({ id: "b", offset: 1, expression: { name: "curious", intensity: 1, duration: 30 } }, "t");
    await vi.advanceTimersByTimeAsync(400); expect(c.state.name).toBe("curious");
    c.endTurn("t"); await vi.advanceTimersByTimeAsync(1201); expect(c.state.name).toBeNull();
  });
  it("preview consumes AI cues without replaying them and cancellation clears stale work", async () => {
    vi.useFakeTimers(); const c = make();
    c.beginPreview();
    const result = c.apply({ id: "a", offset: 0, expression: { name: "happy", intensity: 1 } }, "t");
    expect(result).toBe("skipped-preview"); expect(c.state.name).toBeNull();
    c.endPreview(); c.cancel();
    expect(c.apply({ id: "b", offset: 0, expression: { name: "happy", intensity: 1 } }, "t")).toBe("stale-turn");
  });
});

it('keeps authored mouth opening when audio does not own that parameter', () => {
  const mixer = new ParameterMixer(); const model = core(); model.values.mouth = 0.6;
  mixer.apply(model, 500, { eyes: [], blink: 1, mouthId: 'mouth', mouth: 0, mouthWeight: 0 });
  expect(model.values.mouth).toBe(0.6);
});
