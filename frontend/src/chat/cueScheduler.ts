import type { PerformanceCue } from "../live2d/performanceTypes";

/** Consume in order. A display jump presents only the final target of each channel. */
export function dueCues(cues: PerformanceCue[], from: number, reveal: number, length: number): { next: number; cues: PerformanceCue[] } {
  let next = from;
  let combined: PerformanceCue | null = null;
  while (next < cues.length) {
    const cue = cues[next];
    if (!Number.isInteger(cue.offset) || cue.offset < 0 || cue.offset > length) { next++; continue; }
    if (Math.floor(reveal) < cue.offset) break;
    combined = { ...(combined ?? {}), id: cue.id, offset: cue.offset, ...("expression" in cue ? { expression: cue.expression } : {}), ...(cue.motion ? { motion: cue.motion } : {}) };
    next++;
  }
  return { next, cues: combined ? [combined] : [] };
}
