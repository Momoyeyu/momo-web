import { afterEach, expect, it, vi } from 'vitest';
import { putState } from './stateClient';
afterEach(() => vi.unstubAllGlobals());
it('accepts the state API empty 204 response as a durable save', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 204})));
  expect(await putState({settings:{}})).toBe(true);
});
it('reports a failed settings save', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 500})));
  expect(await putState({settings:{}})).toBe(false);
});
