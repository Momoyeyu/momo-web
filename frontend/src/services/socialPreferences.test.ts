import {describe,it,expect,vi} from 'vitest';
import {createSocialPreferenceWriter} from './socialPreferences';
const account={permissions:{receive:true,reply:true,proactive:false,contacts:false,history:false},allowlistEnabled:false,allowlist:[],enabled:false};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
describe('automatic QQ preference writes',()=>{
  it('projects only changed preference fields, excluding activation and identity',async()=>{
    const save=vi.fn().mockResolvedValue(account);const writer=createSocialPreferenceWriter({save,read:async()=>account,onSettled:vi.fn(),onError:vi.fn(),onBusy:vi.fn()});
    writer.patch({permissions:{reply:false},enabled:true,expectedSelfId:'stale'} as never);await writer.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith({permissions:{reply:false}});
  });
  it('serializes writes and coalesces each pending field to the latest value',async()=>{
    const first=deferred<typeof account>();const save=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(account);const settled=vi.fn();
    const writer=createSocialPreferenceWriter({save,read:async()=>account,onSettled:settled,onError:vi.fn(),onBusy:vi.fn()});
    writer.patch({permissions:{reply:false}});const flushing=writer.flush();
    writer.patch({permissions:{reply:true}});writer.patch({allowlistEnabled:true});writer.patch({permissions:{reply:false,receive:false}});
    expect(save).toHaveBeenCalledTimes(1);first.resolve(account);await flushing;
    expect(save).toHaveBeenCalledTimes(2);expect(save.mock.calls[1]?.[0]).toEqual({permissions:{reply:false,receive:false},allowlistEnabled:true});
    expect(settled.mock.calls[0]?.[1]).toEqual({permissions:{reply:false,receive:false},allowlistEnabled:true});
  });
  it('reads actual preferences after a failed save while retaining newer pending edits',async()=>{
    const first=deferred<typeof account>();const actual={...account,allowlistEnabled:true};const save=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(actual);const settled=vi.fn();const errors=vi.fn();const read=vi.fn().mockResolvedValue(actual);
    const writer=createSocialPreferenceWriter({save,read,onSettled:settled,onError:errors,onBusy:vi.fn()});
    writer.patch({permissions:{reply:false}});const flushing=writer.flush();writer.patch({allowlist:[]});first.resolve(Promise.reject(new Error('failed')) as never);await flushing;
    expect(read).toHaveBeenCalledTimes(1);expect(errors).toHaveBeenCalled();expect(settled.mock.calls[0]).toEqual([actual,{allowlist:[]}]);
    expect(save.mock.calls[1]?.[0]).toEqual({allowlist:[]});
  });
  it('never sends an empty or lifecycle-only patch',async()=>{
    const save=vi.fn();const writer=createSocialPreferenceWriter({save,read:async()=>account,onSettled:vi.fn(),onError:vi.fn(),onBusy:vi.fn()});
    writer.patch({enabled:true} as never);await writer.flush();expect(save).not.toHaveBeenCalled();
  });
});

describe('full QQ capability preferences',()=>{
  it('saves every implemented permission and scope without lifecycle fields',async()=>{
    const save=vi.fn().mockResolvedValue(account);const writer=createSocialPreferenceWriter({save,read:async()=>account});
    writer.patch({permissions:{media:true,friendRequests:true,groups:true,groupManagement:true},groupAllowlist:[{peerId:'123456'}],proactivePolicy:{recipientIds:['234567'],maxPerHour:3}} as never);
    await writer.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith({permissions:{media:true,friendRequests:true,groups:true,groupManagement:true},groupAllowlist:[{peerId:'123456'}],proactivePolicy:{recipientIds:['234567'],maxPerHour:3}});
  });
  it('coalesces proactive limits by changed field without overwriting recipients',async()=>{
    const save=vi.fn().mockResolvedValue(account);const writer=createSocialPreferenceWriter({save,read:async()=>account});
    writer.patch({proactivePolicy:{recipientIds:['234567'],maxPerHour:3}} as never);
    writer.patch({proactivePolicy:{quietStart:23}} as never);
    await writer.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith({proactivePolicy:{recipientIds:['234567'],maxPerHour:3,quietStart:23}});
  });
});
