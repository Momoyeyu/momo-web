import {ambient} from './audio/ambient';
// 唯一生活：标题、见面与其子页面；旧存档地址安全回到标题。
import {useSyncExternalStore} from 'react';
export type Route = 'title' | 'chat' | 'settings' | 'backlog';
const ROUTES: readonly Route[] = ['title','chat','settings','backlog'];
export function currentRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(hash) ? hash as Route : 'title';
}
let pendingBoot = false;
export function navigate(route: Route, intent?: 'boot'): void {
  const source = currentRoute();
  if(route===source || intent==='boot'&&source!=='title')return;
  pendingBoot = route==='chat'&&intent==='boot';
  ambient.sound(route==='chat'?(pendingBoot?'boot':'cancel'):route==='title'?'home':'confirm');
  window.location.hash = `#/${route}`;
}
// The opening belongs to this Boot action, never to the saved history entry.
export function consumeBoot(): boolean {
  const boot = pendingBoot;
  pendingBoot = false;
  return boot;
}
function subscribeHash(fn: () => void): () => void {
  const changed = (event: HashChangeEvent) => {
    if(pendingBoot && new URL(event.newURL).hash!=='#/chat')pendingBoot=false;
    fn();
  };
  window.addEventListener('hashchange', changed);
  return () => window.removeEventListener('hashchange', changed);
}
export function useRoute(): Route {return useSyncExternalStore(subscribeHash,currentRoute);}
