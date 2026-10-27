import {describe,expect,it,vi,beforeEach} from 'vitest';
vi.mock('./http',()=>({apiJson:vi.fn(),jsonInit:(method:string,body:unknown)=>({method,body:JSON.stringify(body)})}));
import {apiJson} from './http';
import {accountDraft,connectSocialAccount,endRetiredSocialWait,parseAllowlist,retiredSocialRecords,saveSocialAccount,socialAccounts,type SocialAccount} from './socialClient';
beforeEach(()=>vi.mocked(apiJson).mockReset());
describe('social configuration boundary',()=>{
  it('preserves an enabled empty allowlist as deny-all and keeps IDs opaque',()=>{
    expect(parseAllowlist(' 000123\n\npeer_alpha\n000123 ')).toEqual([{peerId:'000123'},{peerId:'peer_alpha'}]);
    expect(parseAllowlist(' \n')).toEqual([]);
  });
  it('never includes a credential or owner verification in editable account drafts',()=>{
    const account={enabled:true,accountId:'a',expectedSelfId:'123',endpoint:'ws://127.0.0.1:3001',permissions:{receive:true,reply:true,proactive:false,contacts:false,history:false},allowlistEnabled:true,allowlist:[],ownerPeerId:'owner',hasCredential:true} as unknown as SocialAccount;
    const draft=accountDraft(account);
    expect(draft).not.toHaveProperty('ownerPeerId');expect(draft).not.toHaveProperty('token');
    expect(draft.allowlistEnabled).toBe(true);expect(draft.allowlist).toEqual([]);
  });
  it('an empty token input preserves the existing backend secret',async()=>{
    await saveSocialAccount('qq',{token:'',enabled:false,accountId:'a',expectedSelfId:'123',endpoint:'ws://127.0.0.1:3001',permissions:{receive:false,reply:false,proactive:false,contacts:false,history:false},allowlistEnabled:false,allowlist:[]});
    const body=JSON.parse(String(vi.mocked(apiJson).mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty('token');expect(body.allowlistEnabled).toBe(false);
  });
  it('rejects an incomplete accounts response so Settings can show its retry state',async()=>{
    vi.mocked(apiJson).mockResolvedValueOnce({});
    await expect(socialAccounts()).rejects.toThrow('Invalid social accounts response');
  });
  it('selects managed transport only on explicit chat connection and does not send it on disconnect',async()=>{
    await connectSocialAccount('qq',true,'managed');
    await connectSocialAccount('qq',false,'managed');
    expect(apiJson).toHaveBeenNthCalledWith(1,'/api/social/accounts/qq/connect',{method:'POST',body:'{"transport":"managed"}'});
    expect(apiJson).toHaveBeenNthCalledWith(2,'/api/social/accounts/qq/disconnect',{method:'POST',body:'{}'});
  });
  it('can save displayed policy without enabling a first-time managed account before verified connect',async()=>{
    await saveSocialAccount('qq',{enabled:undefined,permissions:{receive:false,reply:false,proactive:false,contacts:false,history:false},allowlistEnabled:true,allowlist:[]});
    const body=JSON.parse(String(vi.mocked(apiJson).mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty('enabled');expect(body.permissions.reply).toBe(false);expect(body.allowlist).toEqual([]);
  });
  it('reads unresolved retired operations separately from active account configuration',async()=>{
    const records=[{commandId:'old-command',source:'wechat',accountId:null,peerId:null,status:'unknown',createdAt:'old-time',deliveryStatus:'unknown'}];
    vi.mocked(apiJson).mockResolvedValueOnce({records});
    await expect(retiredSocialRecords()).resolves.toEqual(records);
    expect(apiJson).toHaveBeenCalledWith('/api/social/accounts/retired/records',{signal:undefined});
  });
  it('ends a retired wait with only the command and explicit stopped-executor confirmation',async()=>{
    vi.mocked(apiJson).mockResolvedValueOnce({ok:true,records:[]});
    await expect(endRetiredSocialWait('old-command')).resolves.toEqual([]);
    expect(apiJson).toHaveBeenCalledWith('/api/social/accounts/retired/end-wait',{method:'POST',body:JSON.stringify({commandId:'old-command',executorStopped:true})});
  });
  it.each(['read','end-wait'] as const)('rejects malformed archived records from %s so existing records remain available',async operation=>{
    vi.mocked(apiJson).mockResolvedValueOnce({records:null});
    const result=operation==='read'?retiredSocialRecords():endRetiredSocialWait('old-command');
    await expect(result).rejects.toThrow('Invalid retired operations response');
  });
});
