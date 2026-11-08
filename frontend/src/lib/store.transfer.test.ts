import {afterEach, expect, it, vi} from 'vitest';
vi.mock('../services/stateClient',()=>({fetchState:vi.fn(),putState:vi.fn()}));
import {fetchState,putState} from '../services/stateClient';
import type {McpExtension} from './types';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.resetAllMocks();vi.resetModules();});
async function browserStore(){vi.useFakeTimers();vi.stubGlobal('window',{});return import('./store');}
it('awaits an active PUT, flushes queued configuration and suspends writes until export completes',async()=>{
  let finish!:(ok:boolean)=>void;
  vi.mocked(putState).mockReturnValueOnce(new Promise(resolve=>finish=resolve)).mockResolvedValue(true);
  const store=await browserStore(); store.update({avatarId:'before'});
  await vi.advanceTimersByTimeAsync(300);expect(putState).toHaveBeenCalledTimes(1);
  const paused=store.pausePersistence();let settled=false;void paused.then(()=>settled=true);
  await Promise.resolve();expect(settled).toBe(false);
  finish(true);const resume=await paused;
  expect(putState).toHaveBeenCalledTimes(2);
  store.update({avatarId:'background-calibration'});await vi.advanceTimersByTimeAsync(1000);
  expect(putState).toHaveBeenCalledTimes(2);
  resume();await vi.advanceTimersByTimeAsync(300);expect(putState).toHaveBeenCalledTimes(3);
});
it('keeps old pending autosave suspended while successful restore reloads the document',async()=>{
  vi.mocked(putState).mockResolvedValue(true);const store=await browserStore();
  store.update({avatarId:'old-local-state'});await store.pausePersistence();
  expect(putState).toHaveBeenCalledTimes(1);
  store.update({avatarId:'late-old-calibration'});await vi.advanceTimersByTimeAsync(1000);
  expect(putState).toHaveBeenCalledTimes(1);
});
it('resumes persistence after a failed snapshot flush',async()=>{
  vi.mocked(putState).mockResolvedValueOnce(false).mockResolvedValue(true);const store=await browserStore();
  await expect(store.pausePersistence()).rejects.toThrow('Could not save configuration');
  store.update({avatarId:'retry'});await vi.advanceTimersByTimeAsync(300);expect(putState).toHaveBeenCalledTimes(2);
});
it('preserves restricted MCP policy through boot and the next full state PUT',async()=>{
  const store=await browserStore();
  const extension:McpExtension={name:'game',transport:'stdio',enabled:true,command:'node',args:[],env:{},endpoint:'',headers:{},declaredPermissions:['mcp.tools','activities.game'],grantedPermissions:['mcp.tools','activities.game']};
  vi.mocked(fetchState).mockResolvedValue({...store.getState(),settings:{...store.getSettings(),extensions:[extension]}});
  vi.mocked(putState).mockResolvedValue(true);
  await store.bootPersist();await vi.advanceTimersByTimeAsync(300);
  expect(store.getSettings().extensions[0]).toMatchObject({declaredPermissions:extension.declaredPermissions,grantedPermissions:extension.grantedPermissions});
  expect(putState).toHaveBeenLastCalledWith(expect.objectContaining({settings:expect.objectContaining({extensions:[extension]})}));
});

it('replays only unacknowledged switches after quitting before debounce, then releases the journal',async()=>{
 const values=new Map<string,string>();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
 const first=await browserStore();const remote=JSON.parse(JSON.stringify(first.getState()));
 first.updateGeneral({petCloseUp:true,petDialogCollapsed:false,voiceMuted:true,textSpeed:37});
 // Simulate an immediate process exit: no pending timer gets to write the API.
 vi.clearAllTimers();vi.resetModules();
 const second=await browserStore();
 vi.mocked(fetchState).mockResolvedValue(remote);vi.mocked(putState).mockResolvedValue(true);
 await second.bootPersist();
 expect(second.getSettings().general).toMatchObject({petCloseUp:true,petDialogCollapsed:false,voiceMuted:true,textSpeed:37});
 await vi.advanceTimersByTimeAsync(300);
 expect(JSON.parse(values.get('momo-general.pending.v1')!)).toEqual({});
 // A later import/remote setting wins once the previous choice was acknowledged.
 remote.settings.general.petCloseUp=false;
 vi.resetModules();const third=await browserStore();await third.bootPersist();
 expect(third.getSettings().general.petCloseUp).toBe(false);
});
it('does not erase a newer choice when an older save finishes',async()=>{
 const values=new Map<string,string>();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});
 let finish!:(ok:boolean)=>void;
 vi.mocked(putState).mockReturnValueOnce(new Promise(resolve=>finish=resolve));
 const store=await browserStore();store.updateGeneral({petCloseUp:true});
 await vi.advanceTimersByTimeAsync(300);store.updateGeneral({petCloseUp:false});
 finish(true);await Promise.resolve();await Promise.resolve();
 expect(JSON.parse(values.get('momo-general.pending.v1')!)).toEqual({petCloseUp:false});
});
