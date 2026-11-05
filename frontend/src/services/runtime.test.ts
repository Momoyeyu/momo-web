import {afterEach, expect, it, vi} from 'vitest';
afterEach(() => {vi.unstubAllGlobals(); vi.resetModules();});
it('routes desktop requests with header capability and preserves request headers', async () => {
  vi.stubGlobal('window', {momoDesktop: {getRuntime: async () => ({baseUrl: 'http://127.0.0.1:49152', token: 'private'})}});
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const {runtimeFetch} = await import('./runtime');
  await runtimeFetch('/api/state', {headers: {'content-type': 'application/json'}});
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:49152/api/state');
  expect(new Headers(init.headers).get('x-momo-token')).toBe('private');
  expect(new Headers(init.headers).get('content-type')).toBe('application/json');
});
it('keeps web requests same-origin without a token', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const {runtimeFetch} = await import('./runtime');
  await runtimeFetch('/api/state');
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/state');
  expect(new Headers(init.headers).has('x-momo-token')).toBe(false);
});
it.each([
  {baseUrl:'http://127.0.0.1:49152'},
  {baseUrl:'https://evil.example',token:'secret'},
  {baseUrl:'http://127.0.0.1:49152/path',token:'secret'},
  {baseUrl:'http://user@127.0.0.1:49152',token:'secret'},
  {baseUrl:'http://127.0.0.1',token:'secret'},
])('rejects an invalid connection without fetching: %j', async value => {
  vi.stubGlobal('window', {momoDesktop: {getRuntime: async () => value}});
  const {runtime} = await import('./runtime');
  await expect(runtime()).rejects.toThrow('Invalid desktop runtime');
});
it('allows explicit retry after startup failure without falling back to Web', async () => {
  const getRuntime = vi.fn().mockRejectedValueOnce(new Error('Backend startup timed out')).mockResolvedValueOnce({baseUrl:'http://127.0.0.1:49152',token:'private'});
  vi.stubGlobal('window',{momoDesktop:{getRuntime}});
  const {runtime} = await import('./runtime');
  await expect(runtime()).rejects.toThrow('Backend startup timed out');
  await expect(runtime()).resolves.toMatchObject({token:'private'});
});
