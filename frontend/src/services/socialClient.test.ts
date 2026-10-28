import {describe,expect,it,vi,beforeEach} from 'vitest';
vi.mock('./http',()=>({apiJson:vi.fn(),jsonInit:(method:string,body:unknown)=>({method,body:JSON.stringify(body)})}));
import {apiJson} from './http';
import {accountDraft,connectSocialAccount,endRetiredSocialWait,retiredSocialRecords,saveSocialAccount,saveSocialPreferences,uploadQQMedia,removeQQMedia,socialAccounts,type SocialAccount} from './socialClient';
beforeEach(()=>vi.mocked(apiJson).mockReset());
describe('social configuration boundary',()=>{
  it('edits only managed QQ policy, without bridge fields or internal account identity',()=>{
    const account={enabled:true,accountId:'a',expectedSelfId:'123',endpoint:'ws://127.0.0.1:3001',permissions:{receive:true,reply:true,proactive:false,contacts:false,history:false},allowlistEnabled:true,allowlist:[],ownerPeerId:'owner',hasCredential:true} as unknown as SocialAccount;
    const draft=accountDraft(account);
    for(const key of ['ownerPeerId','token','endpoint','transport','accountId','hasCredential'])expect(draft).not.toHaveProperty(key);
    expect(draft.allowlistEnabled).toBe(true);expect(draft.allowlist).toEqual([]);
  });
  it('never sends obsolete bridge fields from a stale runtime draft',async()=>{
    const staleDraft={token:'obsolete-secret',enabled:false,accountId:'a',expectedSelfId:'123',endpoint:'ws://127.0.0.1:3001',transport:'external',permissions:{receive:false,reply:false,proactive:false,contacts:false,history:false},allowlistEnabled:false,allowlist:[]};
    await saveSocialAccount('qq',staleDraft);
    const body=JSON.parse(String(vi.mocked(apiJson).mock.calls[0]?.[1]?.body));
    expect(body).toEqual({enabled:false,expectedSelfId:'123',permissions:staleDraft.permissions,allowlistEnabled:false,allowlist:[]});
  });
  it('rejects an incomplete accounts response so Settings can show its retry state',async()=>{
    vi.mocked(apiJson).mockResolvedValueOnce({});
    await expect(socialAccounts()).rejects.toThrow('Invalid social accounts response');
  });
  it('connects the managed account without a transport choice',async()=>{
    await connectSocialAccount('qq',true);
    await connectSocialAccount('qq',false);
    expect(apiJson).toHaveBeenNthCalledWith(1,'/api/social/accounts/qq/connect',{method:'POST',body:'{}'});
    expect(apiJson).toHaveBeenNthCalledWith(2,'/api/social/accounts/qq/disconnect',{method:'POST',body:'{}'});
  });
  it('can save displayed policy without enabling a first-time managed account before verified connect',async()=>{
    await saveSocialAccount('qq',{enabled:undefined,permissions:{receive:false,reply:false,proactive:false,contacts:false,history:false},allowlistEnabled:true,allowlist:[]});
    const body=JSON.parse(String(vi.mocked(apiJson).mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty('enabled');expect(body.permissions.reply).toBe(false);expect(body.allowlist).toEqual([]);
  });
  it('keeps full permission scopes in auto-save',async()=>{
    const patch={permissions:{groups:true,groupManagement:true},groupAllowlist:[{peerId:'12345'}],proactivePolicy:{recipientIds:['23456'],maxPerHour:3}};
    await saveSocialPreferences('qq',patch);
    expect(JSON.parse(String(vi.mocked(apiJson).mock.calls[0]?.[1]?.body))).toEqual(patch);
  });
  it('uploads an explicit File with multipart encoding and deletes only by opaque media ID',async()=>{
    const file=new File(['synthetic'],'note.txt',{type:'text/plain'});
    await uploadQQMedia(file);
    const upload=vi.mocked(apiJson).mock.calls[0];
    expect(upload?.[0]).toBe('/api/social/accounts/qq/media');
    expect(upload?.[1]?.body).toBeInstanceOf(FormData);
    expect((upload?.[1]?.body as FormData).get('file')).toBe(file);
    await removeQQMedia('opaque/id');
    expect(apiJson).toHaveBeenLastCalledWith('/api/social/accounts/qq/media/opaque%2Fid',{method:'DELETE',signal:undefined});
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
