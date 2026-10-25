import type {ChatMessage, StoredMessage} from '../lib/types';

export function storedMessage(message: StoredMessage): ChatMessage {
  return {...message, id:message.eventId || (message.seq == null ? `legacy-${crypto.randomUUID()}` : `legacy-${message.seq}`)};
}
/** Overlapping pages refer to the same event; repeated words may be separate events. */
export function mergeHistory(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const merged = new Map(existing.map(message => [message.eventId || message.id,message]));
  for (const message of incoming) merged.set(message.eventId || message.id,message);
  return [...merged.values()].sort((a,b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
}
export function groupTranscript(messages: ChatMessage[]): {id:string;messages:ChatMessage[]}[] {
  const groups: {id:string;messages:ChatMessage[]}[] = [];
  for (const message of messages) {
    const last = groups.at(-1);
    const previous = last?.messages.at(-1);
    if (message.runId && previous?.runId === message.runId && previous.role === message.role && previous.source === message.source) last!.messages.push(message);
    else groups.push({id:message.id,messages:[message]});
  }
  return groups;
}
