import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('./runtime',()=>({runtimeFetch:vi.fn()}));
import {runtimeFetch} from './runtime';
import {enterMeeting,leaveMeeting,meetingIdentity,meetingSnapshot,resetMeetingClient} from './meetingClient';
const fetch=vi.mocked(runtimeFetch);
beforeEach(()=>{vi.useFakeTimers();resetMeetingClient();fetch.mockReset();});
afterEach(()=>{resetMeetingClient();vi.useRealTimers();vi.unstubAllGlobals();});
describe('meeting lease client',()=>{
  it('shares one acquisition and exposes only a confirmed lease',async()=>{
    let complete!:(response:Response)=>void;
    fetch.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const first=enterMeeting(),second=enterMeeting();
    expect(meetingIdentity()).toBeUndefined();
    complete(Response.json({leaseId:'lease-1',epoch:4,expiresIn:30}));
    expect(await first).toEqual(await second);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(meetingIdentity()?.leaseId).toBe('lease-1');
  });
  it('retains the same meeting during subpages and revokes local sending on leave',async()=>{
    fetch.mockResolvedValue(Response.json({leaseId:'lease-1',epoch:4,expiresIn:30}));
    await enterMeeting();await enterMeeting();
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(new Response(null,{status:204}));
    await leaveMeeting();
    expect(meetingIdentity()).toBeUndefined();
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/meeting/leave');
  });
  it('fails closed when heartbeat loses ownership',async()=>{
    fetch.mockResolvedValueOnce(Response.json({leaseId:'lease-1',epoch:4,expiresIn:30}));
    await enterMeeting();
    fetch.mockResolvedValue(new Response(null,{status:409}));
    await vi.advanceTimersByTimeAsync(10000);
    expect(meetingIdentity()).toBeUndefined();
    expect(meetingSnapshot().state).toBe('failed');
  });
  it.each(['transport','body'] as const)('keeps proof for server-validated restore while disabling local sending after a heartbeat %s failure',async failure=>{
    const values=new Map<string,string>();
    vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
    fetch.mockResolvedValueOnce(Response.json({leaseId:'lease-before-reload',epoch:4,expiresIn:30}));
    await enterMeeting();
    const stored=values.get('momo.meeting-owner.v1')!;
    if(failure==='transport')fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else fetch.mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.error(new DOMException('Response body aborted during navigation','AbortError'));}})));
    await vi.advanceTimersByTimeAsync(5000);
    expect(meetingSnapshot().state).toBe('failed');
    expect(meetingIdentity()).toBeUndefined();
    expect(values.get('momo.meeting-owner.v1')).toBe(stored);
    fetch.mockResolvedValueOnce(Response.json({leaseId:'restored-lease',epoch:5,expiresIn:30}));
    await enterMeeting(true);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({...JSON.parse(stored),restore:true});
    expect(meetingIdentity()?.leaseId).toBe('restored-lease');
  });
  it('forgets persisted proof after an explicit heartbeat rejection',async()=>{
    const values=new Map<string,string>();
    vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
    fetch.mockResolvedValueOnce(Response.json({leaseId:'rejected-lease',epoch:4,expiresIn:30}));
    await enterMeeting();
    expect(values.has('momo.meeting-owner.v1')).toBe(true);
    fetch.mockResolvedValueOnce(new Response(null,{status:409}));
    await vi.advanceTimersByTimeAsync(5000);
    expect(meetingSnapshot().state).toBe('failed');
    expect(meetingIdentity()).toBeUndefined();
    expect(values.has('momo.meeting-owner.v1')).toBe(false);
    await expect(enterMeeting(true)).rejects.toThrow('Meeting is unavailable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('forgets persisted proof when a decoded heartbeat does not contain a valid lease',async()=>{
    const values=new Map<string,string>();
    vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
    fetch.mockResolvedValueOnce(Response.json({leaseId:'malformed-lease',epoch:4,expiresIn:30}));
    await enterMeeting();
    fetch.mockResolvedValueOnce(Response.json({}));
    await vi.advanceTimersByTimeAsync(5000);
    expect(meetingSnapshot().state).toBe('failed');
    expect(meetingIdentity()).toBeUndefined();
    expect(values.has('momo.meeting-owner.v1')).toBe(false);
    await expect(enterMeeting(true)).rejects.toThrow('Meeting is unavailable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('forgets persisted proof when the normal lease expires without a heartbeat response',async()=>{
    const values=new Map<string,string>();
    vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
    fetch.mockResolvedValueOnce(Response.json({leaseId:'expired-lease',epoch:4,expiresIn:30}));
    await enterMeeting();
    fetch.mockImplementationOnce(()=>new Promise(()=>{}));
    await vi.advanceTimersByTimeAsync(30000);
    expect(meetingIdentity()).toBeUndefined();
    expect(meetingSnapshot().state).toBe('failed');
    expect(values.has('momo.meeting-owner.v1')).toBe(false);
  });
});

it('waits for displayed text persistence before revoking the server lease',async()=>{
  fetch.mockResolvedValueOnce(Response.json({leaseId:'lease-1',epoch:4,expiresIn:30}));
  await enterMeeting();
  let persisted!:()=>void;
  const flush=new Promise<void>(resolve=>{persisted=resolve;});
  fetch.mockResolvedValue(new Response(null,{status:204}));
  const leaving=leaveMeeting(flush);
  expect(meetingIdentity()).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  persisted();await leaving;
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/meeting/leave');
});

it('releases an owned persisted lease after a subpage document reload',async()=>{
  const values=new Map<string,string>([['momo.meeting-owner.v1',JSON.stringify({clientId:'stored-client',leaseId:'stored-lease'})]]);
  vi.stubGlobal('sessionStorage',{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)});
  fetch.mockResolvedValue(new Response(null,{status:204}));
  await leaveMeeting();
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/meeting/leave');
  expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({clientId:'stored-client',leaseId:'stored-lease'});
  expect(values.has('momo.meeting-owner.v1')).toBe(false);
  vi.unstubAllGlobals();
});
