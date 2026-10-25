import {afterEach, expect, it, vi} from 'vitest';
vi.mock('../services/stateClient',()=>({fetchState:vi.fn(),putState:vi.fn()}));
import {putState} from '../services/stateClient';
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
