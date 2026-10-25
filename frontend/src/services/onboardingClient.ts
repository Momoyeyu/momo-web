import { runtimeFetch } from "./runtime";
let pending = false;
let generation: number | null = null;
export function acknowledgeMeetingGeneration(value: number): void {
  if (Number.isInteger(value) && value >= 0) generation = Math.max(generation ?? 0, value);
}
export function meetingGeneration(): number | null { return pending ? generation : null; }
export function firstMeetingPending(): boolean { return pending; }
export interface FirstMeetingStatus {
  stage: 'new' | 'asking' | 'clarifying' | 'completed' | 'skipped' | 'legacy';
  busy: boolean;
  generation: number;
  configured: boolean;
  pendingOpening?: boolean;
}
export async function firstMeetingStatus(): Promise<FirstMeetingStatus | null> {
  try {
    const response = await runtimeFetch('/api/onboarding', {signal: AbortSignal.timeout(5000)});
    if (!response.ok) return null;
    const value = await response.json() as FirstMeetingStatus;
    if (typeof value.stage !== 'string') return null;
    if (typeof value.generation === 'number') acknowledgeMeetingGeneration(value.generation);
    pending = ['new', 'asking', 'clarifying'].includes(value.stage);
    return value;
  } catch { return null; }
}
