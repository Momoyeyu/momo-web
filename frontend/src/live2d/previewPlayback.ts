export interface PreviewPlayback {
  phase: "loading" | "playing" | "finished" | "failed";
  progress: number;
}

/** Cubism 4 queue entry clock is in seconds, including pause / resume. */
export interface MotionPlaybackEntry {
  isStarted(): boolean;
  isFinished(): boolean;
  getStartTime(): number;
  getStateTime(): number;
  _motion: { getDuration(): number };
}

export function motionPlayback(entry: MotionPlaybackEntry): PreviewPlayback {
  if (entry.isFinished()) return { phase: "finished", progress: 1 };
  if (!entry.isStarted()) return { phase: "playing", progress: 0 };
  const duration = entry._motion.getDuration();
  const elapsed = entry.getStateTime() - entry.getStartTime();
  return { phase: "playing", progress: duration > 0 ? Math.max(0, Math.min(0.999, elapsed / duration)) : 0 };
}
