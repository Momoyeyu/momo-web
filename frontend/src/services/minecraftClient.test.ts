import {beforeEach,expect,it,vi} from 'vitest';
const request=vi.hoisted(()=>vi.fn());
vi.mock('./http',()=>({apiJson:request}));
beforeEach(()=>{vi.resetModules();request.mockReset();});
it('refreshes after mutation instead of returning the recent cached switch state',async()=>{
 const client=await import('./minecraftClient');
 request.mockResolvedValueOnce({active:true,paused:false}).mockResolvedValueOnce({active:true,paused:true});
 await client.readMinecraftStatus();
 expect((await client.readMinecraftStatus(true)).paused).toBe(true);
 expect(request).toHaveBeenCalledTimes(2);
});
it('a pre-mutation in-flight response cannot overwrite the fresh state',async()=>{
 const client=await import('./minecraftClient');
 let old!:(value:unknown)=>void;
 request.mockImplementationOnce(()=>new Promise(resolve=>{old=resolve;})).mockResolvedValueOnce({active:false});
 const stale=client.readMinecraftStatus();
 await client.readMinecraftStatus(true);
 old({active:true});await stale;
 expect(client.minecraftSnapshot()?.active).toBe(false);
});
