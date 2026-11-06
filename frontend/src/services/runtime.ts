import type {DesktopWindowBridge} from './desktopWindow';
/** Desktop credentials live only in memory and never enter URLs or persisted settings. */
export interface Runtime { baseUrl: string; token?: string }
declare global {
  interface Window { momoDesktop?: {getRuntime(): Promise<Runtime>} & Partial<DesktopWindowBridge> }
}
let pending: Promise<Runtime> | undefined;
export function desktop(): boolean { return typeof window !== 'undefined' && 'momoDesktop' in window; }
async function resolveDesktopRuntime(): Promise<Runtime> {
  const value = await window.momoDesktop!.getRuntime();
  const url = new URL(value.baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      typeof value.token !== 'string' || !value.token)
    throw new Error('Invalid desktop runtime');
  return value;
}
export function runtime(): Promise<Runtime> {
  if (!desktop()) return Promise.resolve({baseUrl: ''});
  pending ??= resolveDesktopRuntime().catch(error => { pending = undefined; throw error; });
  return pending;
}
export async function runtimeFetch(path: string, init?: RequestInit): Promise<Response> {
  const rt = await runtime();
  if (!path.startsWith('/api/')) return fetch(path, init);
  const headers = new Headers(init?.headers);
  if (rt.token) headers.set('x-momo-token', rt.token);
  return fetch(`${rt.baseUrl}${path}`, {...init, headers});
}
