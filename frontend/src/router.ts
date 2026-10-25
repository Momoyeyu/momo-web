// 唯一生活：标题、见面与其子页面；旧存档地址安全回到标题。
import {useSyncExternalStore} from 'react';
export type Route = 'title' | 'chat' | 'settings' | 'backlog';
const ROUTES: readonly Route[] = ['title','chat','settings','backlog'];
function currentRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(hash) ? hash as Route : 'title';
}
let from: Route | null = null;
export function navigate(route: Route): void {
  from = currentRoute();
  window.location.hash = `#/${route}`;
}
export function fromRoute(): Route {return from ?? 'title';}
function subscribeHash(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}
export function useRoute(): Route {return useSyncExternalStore(subscribeHash,currentRoute);}
