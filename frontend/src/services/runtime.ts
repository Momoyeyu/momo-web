/** Desktop credentials live only in memory and never enter URLs or persisted settings. */
export interface Runtime { baseUrl: string; token?: string }
let pending: Promise<Runtime> | undefined;
export function desktop(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window; }
async function resolveDesktopRuntime(): Promise<Runtime> {
  const invoke = (window as unknown as {__TAURI_INTERNALS__: {invoke: (cmd: string) => Promise<Runtime>}}).__TAURI_INTERNALS__.invoke;
  const deadline = Date.now() + 55000;
  while (true) {
    try {
      const value = await invoke('get_runtime');
      const url = new URL(value.baseUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !value.token)
        throw new Error('Invalid desktop runtime');
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : error;
      if (message !== 'Backend is starting') throw error;
      if (Date.now() >= deadline) throw new Error('Desktop startup timed out');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
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
