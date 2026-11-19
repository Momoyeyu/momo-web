import {useSyncExternalStore} from 'react';
import {apiJson} from './http';

export type ModResource = {type:'background'|'bgm'; path:string; url:string};
export type InstalledMod = {id:string; name:string; version:string; kind:'content'|'integration'; source:'official'|'local'; platforms:string[]; enabled:boolean; runtimeError?:string|null; resources:ModResource[]};
let records: InstalledMod[] = [];
let revision = 0;
const subscribers = new Set<()=>void>();
let changes:BroadcastChannel|null=null;

function publish(next: InstalledMod[]) {
  records=next;
  subscribers.forEach(fn=>fn());
}

// The backend acknowledges the new record before a subsequent list refresh.
// Apply it immediately so a failed refresh cannot leave a disabled asset active.
export function applyModChange(id:string, record:InstalledMod|null) {
  revision++;
  const next=records.filter(item=>item.id!==id);
  if(record)next.push(record);
  publish(next.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
  changes?.postMessage('changed');
}

export function observeMods() {
  const refresh=()=>{void refreshMods().catch(()=>{});};
  if(typeof BroadcastChannel!=='undefined'){
    changes=new BroadcastChannel('momo-mod-catalog');
    changes.onmessage=refresh;
  }
  window.addEventListener('focus',refresh);
  refresh();
  return ()=>{changes?.close();changes=null;window.removeEventListener('focus',refresh);};
}

export async function refreshMods() {
  const request = ++revision;
  const response = await apiJson<{mods:InstalledMod[]}>('/api/mods');
  if (!Array.isArray(response.mods)) throw Error('Invalid mod list');
  if (request !== revision) return;
  publish(response.mods);
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
