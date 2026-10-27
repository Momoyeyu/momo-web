import {afterEach,describe,expect,it,vi} from 'vitest';
import {observeQQRuntime,parseQQRuntime,QQLoginError,qqRuntimeAction,qqRuntimeStatus,visibleQQRuntime,type QQRuntimeState} from './qqRuntimeClient';
import {runtimeFetch} from './runtime';

vi.mock('./runtime',()=>({runtimeFetch:vi.fn()}));
const state=(status='idle'):QQRuntimeState=>({provider:'qq',status:status as QQRuntimeState['status'],running:false,connected:false,actualSelfId:null,attemptId:null,error:null,executorQuiescent:true,qr:null});
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
afterEach(()=>{vi.useRealTimers();vi.mocked(runtimeFetch).mockReset();});

describe('managed QQ login boundary',()=>{
  it('uses fixed authenticated local routes and never accepts a runtime path or endpoint',async()=>{
    vi.mocked(runtimeFetch).mockImplementation(async()=>new Response(JSON.stringify(state())));
    await qqRuntimeStatus();await qqRuntimeAction('begin');
    expect(runtimeFetch).toHaveBeenNthCalledWith(1,'/api/social/accounts/qq/runtime',expect.objectContaining({cache:'no-store'}));
    expect(runtimeFetch).toHaveBeenNthCalledWith(2,'/api/social/accounts/qq/runtime/begin',expect.objectContaining({method:'POST',body:'{}',cache:'no-store'}));
  });
  it('rejects unrecognized runtime actions before issuing a request',async()=>{
    await expect(qqRuntimeAction('../connect' as never)).rejects.toMatchObject({code:'INPUT'});
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
  it('bounds a stalled request without leaving the QR screen waiting forever',async()=>{
    vi.useFakeTimers();
    vi.mocked(runtimeFetch).mockImplementation((_path,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));}));
    const result=qqRuntimeStatus();const assertion=expect(result).rejects.toMatchObject({code:'RUNTIME_TIMEOUT'});
    await vi.advanceTimersByTimeAsync(45000);await assertion;
  });
  it('maps only known server error codes and does not expose raw host details',async()=>{
    vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify({detail:{code:'RESOURCE_UNAVAILABLE',message:'/private/secret'}}),{status:409}));
    await expect(qqRuntimeAction('begin')).rejects.toMatchObject({code:'RESOURCE_UNAVAILABLE',message:'RESOURCE_UNAVAILABLE'});
    vi.mocked(runtimeFetch).mockResolvedValueOnce(new Response(JSON.stringify({detail:{code:'/private/token',message:'secret'}}),{status:500}));
    await expect(qqRuntimeAction('begin')).rejects.toMatchObject({code:'RUNTIME_FAILED',message:'RUNTIME_FAILED'});
  });
  it('accepts only bounded PNG QR images attached to a live attempt',()=>{
    const pending={...state('qr_pending'),running:true,executorQuiescent:false,attemptId:'attempt-a',qr:{dataUrl:'data:image/png;base64,iVBORw0KGgo=',expiresAt:Date.now()+30000}};
    expect(parseQQRuntime(pending).qr).toEqual(pending.qr);
    for(const dataUrl of ['https://example.com/token','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,aaaa','data:image/png;base64,'+'a'.repeat(400000)])expect(()=>parseQQRuntime({...pending,qr:{...pending.qr,dataUrl}})).toThrow(QQLoginError);
    expect(()=>parseQQRuntime({...pending,attemptId:null})).toThrow(QQLoginError);
    expect(()=>parseQQRuntime({...pending,provider:'wechat'})).toThrow(QQLoginError);
    expect(()=>parseQQRuntime({...pending,status:'cancelled'})).toThrow(QQLoginError);
    expect(()=>parseQQRuntime({...pending,qr:{...pending.qr,expiresAt:Date.now()+11*60*1000}})).toThrow(QQLoginError);
  });
  it('never displays a connected identity unless the state is internally consistent',()=>{
    expect(()=>parseQQRuntime({...state('connected'),connected:true,actualSelfId:null})).toThrow(QQLoginError);
    expect(()=>parseQQRuntime({...state('identity_mismatch'),actualSelfId:'123',connected:true})).toThrow(QQLoginError);
    expect(()=>parseQQRuntime({...state('connected'),connected:true,running:true,actualSelfId:'123'})).toThrow(QQLoginError);
    expect(parseQQRuntime({...state('connected'),connected:true,running:true,executorQuiescent:false,actualSelfId:'123'}).actualSelfId).toBe('123');
  });
  it('removes a QR image at expiry even before the next server poll',()=>{
    const runtime={...state('qr_pending'),qr:{dataUrl:'data:image/png;base64,iVBORw0KGgo=',expiresAt:1000}};
    expect(visibleQQRuntime(runtime,999).qr).not.toBeNull();
    expect(visibleQQRuntime(runtime,1000)).toMatchObject({status:'expired',qr:null});
  });
});

describe('QQ login observation races',()=>{
  it('ignores a late poll after closing and never invokes a server logout',async()=>{
    const pending=deferred<QQRuntimeState>();const read=vi.fn(()=>pending.promise);const action=vi.fn();const onState=vi.fn();
    const observer=observeQQRuntime({read,action,onState,onError:vi.fn(),onBusy:vi.fn()});observer.start();observer.dispose();pending.resolve(state('connected'));await pending.promise;await Promise.resolve();
    expect(onState).not.toHaveBeenCalled();expect(action).not.toHaveBeenCalled();
  });
  it('a refresh fences the older QR poll so it cannot resurrect the previous QR',async()=>{
    const old=deferred<QQRuntimeState>();const replacement={...state('qr_pending'),attemptId:'new'};const onState=vi.fn();
    const observer=observeQQRuntime({read:vi.fn(()=>old.promise),action:vi.fn(async()=>replacement),onState,onError:vi.fn(),onBusy:vi.fn()});
    observer.start();await observer.act('refresh');old.resolve({...state('qr_pending'),attemptId:'old'});await old.promise;await Promise.resolve();
    expect(onState.mock.calls.map(call=>call[0])).toEqual([null,replacement]);observer.dispose();
  });
  it('polls sequentially and clears sensitive state when status cannot be verified',async()=>{
    vi.useFakeTimers();const pending=deferred<QQRuntimeState>();const read=vi.fn().mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new QQLoginError('RUNTIME_FAILED'));const onState=vi.fn();const onError=vi.fn();
    const observer=observeQQRuntime({read,action:vi.fn(),onState,onError,onBusy:vi.fn(),intervalMs:1000});observer.start();await vi.advanceTimersByTimeAsync(5000);expect(read).toHaveBeenCalledTimes(1);
    pending.resolve(state());await pending.promise;await Promise.resolve();await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);expect(onState).toHaveBeenLastCalledWith(null);expect(onError).toHaveBeenCalledWith('RUNTIME_FAILED');observer.dispose();
  });
  it('cancel cannot be overwritten by an older in-flight begin response',async()=>{
    const begin=deferred<QQRuntimeState>();const onState=vi.fn();const action=vi.fn((method:string)=>method==='begin'?begin.promise:Promise.resolve(state('cancelled')));
    const observer=observeQQRuntime({read:vi.fn(async()=>state()),action,onState,onError:vi.fn(),onBusy:vi.fn()});observer.start();await Promise.resolve();
    const starting=observer.act('begin');await observer.act('cancel');begin.resolve(state('qr_pending'));await starting;
    expect(onState).toHaveBeenLastCalledWith(state('cancelled'));observer.dispose();
  });
});
