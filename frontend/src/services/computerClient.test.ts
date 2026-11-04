import {afterEach,expect,it,vi} from 'vitest';
vi.mock('./http',()=>({apiJson:vi.fn(),apiFetch:vi.fn(),jsonInit:(method:string,body:unknown)=>({method,body})}));
vi.mock('./meetingClient',()=>({meetingIdentity:()=>({clientId:'test',leaseId:'test'}),subscribeMeeting:()=>()=>{},meetingSnapshot:()=>({attention:{focus:false}})}));
import {apiJson} from './http';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
it('does not start server observation when stopped while video prepares',async()=>{
 const play=deferred(),stop=vi.fn();
 vi.stubGlobal('navigator',{mediaDevices:{getDisplayMedia:async()=>({getTracks:()=>[{stop}],getVideoTracks:()=>[{label:'test'}]})}});
 vi.stubGlobal('document',{createElement:()=>({play:()=>play.promise})});
 vi.mocked(apiJson).mockResolvedValue({observing:false});
 const {startComputer,stopComputer}=await import('./computerClient');
 const started=startComputer();await Promise.resolve();await stopComputer();play.resolve();await started;
 expect(stop).toHaveBeenCalled();
 expect(vi.mocked(apiJson).mock.calls.some(([url])=>url==='/api/computer/start')).toBe(false);
});
it('waits for an in-flight server start before sending stop',async()=>{
 const request=deferred();
 vi.stubGlobal('navigator',{mediaDevices:{getDisplayMedia:async()=>({getTracks:()=>[{stop:()=>{}}],getVideoTracks:()=>[{label:'test'}]})}});
 vi.stubGlobal('document',{createElement:()=>({play:async()=>{}})});
 vi.mocked(apiJson).mockImplementation(async url=>{if(url==='/api/computer/start')await request.promise;return {observing:false,generation:1};});
 const {startComputer,stopComputer}=await import('./computerClient');
 const started=startComputer();await vi.waitFor(()=>expect(apiJson).toHaveBeenCalledWith('/api/computer/start',expect.anything()));
 const stopped=stopComputer();expect(vi.mocked(apiJson).mock.calls.filter(([url])=>url==='/api/computer/stop')).toHaveLength(0);
 request.resolve();await Promise.all([started,stopped]);
 expect(vi.mocked(apiJson).mock.calls.at(-1)?.[0]).toBe('/api/computer/stop');
});
