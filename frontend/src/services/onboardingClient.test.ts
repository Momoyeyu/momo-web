import { afterEach, expect, it, vi } from 'vitest';
import { firstMeetingStatus, meetingGeneration } from './onboardingClient';
import { interrupt } from './chatClient';
afterEach(() => vi.unstubAllGlobals());
it('awaited interrupt advances the next-turn generation before any new sentence', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/onboarding'
    ? new Response(JSON.stringify({stage:'asking',generation:0,busy:false,configured:true}))
    : new Response(null, {status:204,headers:{'x-momo-generation':'1'}})));
  await firstMeetingStatus();
  expect(meetingGeneration()).toBe(0);
  await interrupt('', '啊', 0);
  expect(meetingGeneration()).toBe(1);
  await firstMeetingStatus(); // A late poll must not regress the cache.
  expect(meetingGeneration()).toBe(1);
});
