import { expect, it } from "vitest";
import { motionPlayback, type MotionPlaybackEntry } from "./previewPlayback";

const entry = (overrides: Partial<MotionPlaybackEntry> = {}): MotionPlaybackEntry => ({
  isStarted: () => true, isFinished: () => false,
  getStartTime: () => 10, getStateTime: () => 12,
  _motion: { getDuration: () => 4 }, ...overrides,
});
it("reads the animation clock and waits for the actual finish signal", () => {
  expect(motionPlayback(entry()).progress).toBe(0.5);
  expect(motionPlayback(entry({ getStateTime: () => 20 })).phase).toBe("playing");
  expect(motionPlayback(entry({ isFinished: () => true }))).toEqual({ phase: "finished", progress: 1 });
});
it("does not invent elapsed time before the first rendered frame", () => {
  expect(motionPlayback(entry({ isStarted: () => false })).progress).toBe(0);
});
