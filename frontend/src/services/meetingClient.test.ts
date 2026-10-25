import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('./runtime',()=>({runtimeFetch:vi.fn()}));
import {runtimeFetch} from './runtime';
import {enterMeeting,leaveMeeting,meetingIdentity,meetingSnapshot,resetMeetingClient} from './meetingClient';
const fetch=vi.mocked(runtimeFetch);
beforeEach(()=>{vi.useFakeTimers();resetMeetingClient();fetch.mockReset();});
afterEach(()=>{resetMeetingClient();vi.useRealTimers();});
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
