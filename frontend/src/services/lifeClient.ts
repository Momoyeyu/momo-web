import {apiJson} from './http';
import type {StoredMessage} from '../lib/types';

export interface HistoryPage {
  messages: StoredMessage[];
  hasMore: boolean;
  nextBefore: number | null;
}
export interface LiveTranscript {summary:string; messages:StoredMessage[]}
/** Reads a projection of the same continuous life; never creates or restores a branch. */
export function liveTranscript(): Promise<LiveTranscript> {
  return apiJson<LiveTranscript>('/api/life/live');
}
export function historyPage(before?: number, signal?: AbortSignal): Promise<HistoryPage> {
  const params = new URLSearchParams({limit:'100'});
  if (before !== undefined) params.set('before', String(before));
  return apiJson<HistoryPage>(`/api/life/history?${params}`, {signal});
}
