import {apiJson,jsonInit} from './http';

export type SocialProvider='qq';
export type SocialPermission='receive'|'reply'|'proactive'|'contacts'|'history';
export type SocialPermissions=Record<SocialPermission,boolean>;
export interface SocialPeer {peerId:string;label?:string}
export interface SocialAccount {
  provider:SocialProvider;id:string;enabled:boolean;accountId:string;expectedSelfId:string;
  endpoint:string;hasCredential:boolean;permissions:SocialPermissions;
  allowlistEnabled:boolean;allowlist:SocialPeer[];ownerPeerId?:string;
  status:string;actualSelfId?:string;policyRevision:number;error?:string;
  capabilities:Partial<Record<SocialPermission|'ownerBinding',boolean>>;
}
export interface SocialDraft {
  enabled:boolean;accountId:string;expectedSelfId:string;endpoint:string;token?:string;
  permissions:SocialPermissions;allowlistEnabled:boolean;allowlist:SocialPeer[];
}
export interface SocialRecord {
  commandId:string;status:string;peerId?:string;createdAt?:string;error?:string;
  executorQuiescent?:boolean;evidence?:string|Record<string,unknown>;
}
export interface RetiredSocialRecord {
  commandId:string;source:'wechat';accountId:string|null;peerId:string|null;
  status:'unknown';createdAt:string;deliveryStatus:'unknown';
}
export const SOCIAL_PROVIDERS:readonly SocialProvider[]=['qq'];
export function accountDraft(account:SocialAccount):SocialDraft {
  // Credential values and verified owner bindings never enter editable drafts.
  return {enabled:account.enabled,accountId:account.accountId,expectedSelfId:account.expectedSelfId,endpoint:account.endpoint,permissions:{...account.permissions},allowlistEnabled:account.allowlistEnabled,allowlist:account.allowlist.map(peer=>({...peer}))};
}
export function parseAllowlist(text:string):SocialPeer[] {
  const unique=new Map<string,SocialPeer>();
  for(const raw of text.split(/\r?\n/)){
    const peerId=raw.trim();if(peerId)unique.set(peerId,{peerId});
  }
  return [...unique.values()];
}
export async function socialAccounts(signal?:AbortSignal):Promise<{accounts:SocialAccount[];providers:unknown[]}> {
  const response=await apiJson<{accounts:SocialAccount[];providers:unknown[]}>('/api/social/accounts',{signal});
  if(!Array.isArray(response?.accounts)||!Array.isArray(response.providers))throw new Error('Invalid social accounts response');
  return response;
}
export function saveSocialAccount(provider:SocialProvider,draft:SocialDraft):Promise<SocialAccount> {
  const body={...draft,token:draft.token?.trim()||undefined};
  return apiJson(`/api/social/accounts/${provider}`,jsonInit('PUT',body));
}
export function connectSocialAccount(provider:SocialProvider,connect:boolean):Promise<SocialAccount> {
  return apiJson(`/api/social/accounts/${provider}/${connect?'connect':'disconnect'}`,jsonInit('POST',{}));
}
export function resumeSocialAccount(provider:SocialProvider):Promise<SocialAccount> {
  return apiJson(`/api/social/accounts/${provider}/resume`,jsonInit('POST',{}));
}
export async function socialRecords(provider:SocialProvider,signal?:AbortSignal):Promise<SocialRecord[]> {
  const result=await apiJson<{records:SocialRecord[]}>(`/api/social/accounts/${provider}/records`,{signal});
  return result.records;
}
export function reconcileSocialRecord(provider:SocialProvider,commandId:string,outcome:'completed'|'failed'|'closed_unknown'):Promise<unknown> {
  return apiJson(`/api/social/accounts/${provider}/reconcile`,jsonInit('POST',{commandId,outcome}));
}
export function ownerChallenge(provider:SocialProvider,peerId:string):Promise<{challenge:string;expiresAt:string|number}> {
  return apiJson(`/api/social/accounts/${provider}/owner-challenge`,jsonInit('POST',{peerId}));
}
export async function retiredSocialRecords(signal?:AbortSignal):Promise<RetiredSocialRecord[]> {
  const result=await apiJson<{records:RetiredSocialRecord[]}>('/api/social/accounts/retired/records',{signal});
  if(!Array.isArray(result?.records))throw new Error('Invalid retired operations response');
  return result.records;
}
export async function endRetiredSocialWait(commandId:string):Promise<RetiredSocialRecord[]> {
  const result=await apiJson<{records:RetiredSocialRecord[]}>('/api/social/accounts/retired/end-wait',jsonInit('POST',{commandId,executorStopped:true}));
  if(!Array.isArray(result?.records))throw new Error('Invalid retired operations response');
  return result.records;
}
