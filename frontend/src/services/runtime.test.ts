import {afterEach, expect, it, vi} from 'vitest';
afterEach(() => {vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers();});
it('routes desktop requests with header capability and preserves request headers', async () => {
  const invoke = vi.fn(async () => ({baseUrl: 'http://127.0.0.1:49152', token: 'private'}));
  vi.stubGlobal('window', {__TAURI_INTERNALS__: {invoke}});
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const {runtimeFetch} = await import('./runtime');
  await runtimeFetch('/api/state', {headers: {'content-type': 'application/json'}});
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:49152/api/state');
  expect(new Headers(init.headers).get('x-momo-token')).toBe('private');
  expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  expect(invoke).toHaveBeenCalledWith('get_runtime');
});
it('keeps web development requests same-origin without a token', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const {runtimeFetch} = await import('./runtime');
  await runtimeFetch('/api/state');
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/state');
  expect(new Headers(init.headers).has('x-momo-token')).toBe(false);
});
it('allows retry after IPC failure and rejects remote runtime endpoints', async () => {
  const invoke = vi.fn().mockRejectedValueOnce(new Error('startup')).mockResolvedValueOnce({baseUrl: 'http://127.0.0.1:49152', token: 'private'});
  vi.stubGlobal('window', {__TAURI_INTERNALS__: {invoke}});
  const {runtime} = await import('./runtime');
  await expect(runtime()).rejects.toThrow('startup');
  await expect(runtime()).resolves.toEqual({baseUrl: 'http://127.0.0.1:49152', token: 'private'});
});
it('waits through the explicit startup state before resolving runtime', async () => {
  vi.useFakeTimers();
  const invoke = vi.fn().mockRejectedValueOnce('Backend is starting').mockResolvedValue({baseUrl:'http://127.0.0.1:49152', token:'private'});
  vi.stubGlobal('window', {__TAURI_INTERNALS__:{invoke}});
  const {runtime} = await import('./runtime');
  const ready = runtime();
  await vi.advanceTimersByTimeAsync(250);
  await expect(ready).resolves.toMatchObject({token:'private'});
  expect(invoke).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
it('does not retry runtime access denial', async () => {
  const invoke = vi.fn().mockRejectedValue('Runtime access denied');
  vi.stubGlobal('window', {__TAURI_INTERNALS__:{invoke}});
  const {runtime} = await import('./runtime');
  await expect(runtime()).rejects.toBe('Runtime access denied');
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('times out a backend that never leaves startup', async () => {
  vi.useFakeTimers();
  const invoke = vi.fn().mockRejectedValue('Backend is starting');
  vi.stubGlobal('window', {__TAURI_INTERNALS__:{invoke}});
  const {runtime} = await import('./runtime');
  const failure = expect(runtime()).rejects.toThrow('Desktop startup timed out');
  await vi.advanceTimersByTimeAsync(55000);
  await failure;
  vi.useRealTimers();
});
