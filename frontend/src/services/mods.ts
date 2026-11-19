import {useSyncExternalStore} from 'react';
import {apiJson} from './http';

export type ModResource = {type:'background'|'bgm'; path:string; url:string};
export type InstalledMod = {id:string; name:string; version:string; kind:'content'|'integration'; enabled:boolean; runtimeError?:string|null; resources:ModResource[]};
let records: InstalledMod[] = [];
let revision = 0;
const subscribers = new Set<()=>void>();

export async function refreshMods() {
  const request = ++revision;
  const response = await apiJson<{mods:InstalledMod[]}>('/api/mods');
  if (!Array.isArray(response.mods)) throw Error('Invalid mod list');
  if (request !== revision) return;
  records = response.mods;
  subscribers.forEach(fn=>fn());
}
export function useMods() {
  return useSyncExternalStore(subscribeMods,()=>records);
}
export function subscribeMods(fn:()=>void) {
  subscribers.add(fn);
  return ()=>{subscribers.delete(fn);};
}
export function activeResource(type:ModResource['type']) {
  // Prefer the last enabled pack in the catalog's stable order.
  for (const mod of [...records].reverse()) {
    const resource=mod.enabled && mod.resources.find(r=>r.type===type);
    if (resource) return resource.url;
  }
  return null;
}
