import {describe, expect, it} from 'vitest';
import {mergeHistory, groupTranscript, storedMessage} from './transcript';
import type {ChatMessage} from '../lib/types';

const message = (id: string, role: 'user' | 'assistant', runId?: string, seq?: number): ChatMessage => ({id, role, text:id, at:'t', runId, seq});
describe('continuous transcript identity', () => {
  it('uses durable event identity and keeps source/run metadata after reload', () => {
    expect(storedMessage({role:'assistant',text:'hello',at:'t',eventId:'event-1',runId:'run-1',source:'virtual',externalMessageId:'remote-1',seq:4})).toEqual({id:'event-1',role:'assistant',text:'hello',at:'t',eventId:'event-1',runId:'run-1',source:'virtual',externalMessageId:'remote-1',seq:4});
  });
  it('merges overlapping history pages by event identity, never equal text', () => {
    expect(mergeHistory([message('event-2','user','run-2',2)], [message('event-1','user','run-1',1),message('event-2','user','run-2',2)])).toEqual([message('event-1','user','run-1',1),message('event-2','user','run-2',2)]);
  });
  it('groups only the same run/role/source without assuming adjacent assistant means same turn', () => {
    const rows = [message('a','assistant','run-1',1),message('b','assistant','run-1',2),message('c','assistant','run-2',3),message('d','assistant',undefined,4),message('e','assistant',undefined,5)];
    expect(groupTranscript(rows).map(item => item.messages.map(m=>m.id))).toEqual([['a','b'],['c'],['d'],['e']]);
  });
});
