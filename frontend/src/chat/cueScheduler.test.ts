import { describe, expect, it } from "vitest";
import { dueCues } from "./cueScheduler";

const cues = [
  { id: "0", offset: 0, expression: { name: "happy", intensity: 1 } },
  { id: "1", offset: 2, motion: "Idle/2" },
  { id: "2", offset: 3, expression: { name: "curious", intensity: 1 } },
  { id: "3", offset: 4, expression: null },
];
describe("presentation cursor", () => {
  it("honors actual sentence-end position and consumes exactly once", () => {
    const first = dueCues(cues, 0, 0, 4);
    expect(first.next).toBe(1); expect(first.cues[0].expression?.name).toBe("happy");
    expect(dueCues(cues, 1, 1, 4).cues).toEqual([]);
    const mid = dueCues(cues, 1, 3, 4);
    expect(mid.next).toBe(3); expect(mid.cues).toHaveLength(1);
    expect(mid.cues[0]).toMatchObject({ motion: "Idle/2", expression: { name: "curious" } });
    expect(dueCues(cues, 3, 3, 4).cues).toEqual([]);
    expect(dueCues(cues, 3, 4, 4).cues[0].expression).toBeNull();
    expect(dueCues(cues, 4, 4, 4).cues).toEqual([]);
  });
  it("drops invalid anchors and coalesces instant display per channel", () => {
    const result = dueCues([...cues, { id: "bad", offset: 99, motion: "wrong" }], 0, 4, 4);
    expect(result.next).toBe(5); expect(result.cues).toHaveLength(1);
    expect(result.cues[0]).toMatchObject({ expression: null, motion: "Idle/2" });
  });
});
