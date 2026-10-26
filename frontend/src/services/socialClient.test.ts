import {describe,expect,it,vi,beforeEach} from 'vitest';
vi.mock('./http',()=>({apiJson:vi.fn(),jsonInit:(method:string,body:unknown)=>({method,body:JSON.stringify(body)})}));
import {apiJson} from './http';
import {accountDraft,parseAllowlist,saveSocialAccount,socialAccounts,type SocialAccount} from './socialClient';
beforeEach(()=>vi.mocked(apiJson).mockReset());
describe('social configuration boundary',()=>{
  it('preserves an enabled empty allowlist as deny-all and keeps IDs opaque',()=>{
    expect(parseAllowlist(' 000123\n\nwxid_a\n000123 ')).toEqual([{peerId:'000123'},{peerId:'wxid_a'}]);
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
});
