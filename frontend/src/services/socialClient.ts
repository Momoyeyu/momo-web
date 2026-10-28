import {apiJson,jsonInit} from './http';
import {createSocialPreferenceWriter,type SocialPreferencePatch} from './socialPreferences';

export type SocialProvider='qq';
export const SOCIAL_PERMISSIONS=['receive','reply','proactive','contacts','history','media','friendRequests','groups','groupManagement'] as const;
export type SocialPermission=typeof SOCIAL_PERMISSIONS[number];
export type SocialPermissions=Record<'receive'|'reply'|'proactive'|'contacts'|'history',boolean>&Partial<Record<'media'|'friendRequests'|'groups'|'groupManagement',boolean>>;
export interface SocialProactivePolicy {recipientIds:string[];maxPerHour:number;minIntervalSeconds:number;quietStart:number;quietEnd:number}
export const DEFAULT_PROACTIVE_POLICY:SocialProactivePolicy={recipientIds:[],maxPerHour:6,minIntervalSeconds:60,quietStart:22,quietEnd:8};
export interface SocialPeer {peerId:string;label?:string}
export interface SocialAccount {
  provider:SocialProvider;id:string;enabled:boolean;accountId:string;expectedSelfId:string;
  permissions:SocialPermissions;
  allowlistEnabled:boolean;allowlist:SocialPeer[];ownerPeerId?:string;
  proactivePolicy?:SocialProactivePolicy;groupAllowlist?:SocialPeer[];
  status:string;actualSelfId?:string;policyRevision:number;error?:string;
  transport:'managed';
  capabilities:Partial<Record<SocialPermission|'ownerBinding',boolean>>;
}
export interface SocialDraft {
  enabled:boolean;expectedSelfId:string;
  permissions:SocialPermissions;allowlistEnabled:boolean;allowlist:SocialPeer[];
  proactivePolicy?:SocialProactivePolicy;groupAllowlist?:SocialPeer[];
}
export interface SocialRecord {
  commandId:string;status:string;peerId?:string;createdAt?:string;error?:string;action?:string;
  executorQuiescent?:boolean;evidence?:string|Record<string,unknown>;
}
export interface RetiredSocialRecord {
  commandId:string;source:'wechat';accountId:string|null;peerId:string|null;
  status:'unknown';createdAt:string;deliveryStatus:'unknown';
}
export const SOCIAL_PROVIDERS:readonly SocialProvider[]=['qq'];
export function accountDraft(account:SocialAccount):SocialDraft {
  // Login identity and verified owner bindings are not editable policy fields.
  return {enabled:account.enabled,expectedSelfId:account.expectedSelfId,permissions:{...account.permissions},allowlistEnabled:account.allowlistEnabled,allowlist:account.allowlist.map(peer=>({...peer})),proactivePolicy:account.proactivePolicy?{...account.proactivePolicy,recipientIds:[...account.proactivePolicy.recipientIds]}:undefined,groupAllowlist:account.groupAllowlist?.map(peer=>({...peer}))};
}
export async function socialAccounts(signal?:AbortSignal):Promise<{accounts:SocialAccount[];providers:unknown[]}> {
  const response=await apiJson<{accounts:SocialAccount[];providers:unknown[]}>('/api/social/accounts',{signal});
  if(!Array.isArray(response?.accounts)||!Array.isArray(response.providers))throw new Error('Invalid social accounts response');
  return response;
}
export function saveSocialAccount(provider:SocialProvider,draft:Partial<SocialDraft>):Promise<SocialAccount> {
  const {enabled,expectedSelfId,permissions,allowlistEnabled,allowlist,proactivePolicy,groupAllowlist}=draft;
  const body={enabled,expectedSelfId,permissions,allowlistEnabled,allowlist,proactivePolicy,groupAllowlist};
  return apiJson(`/api/social/accounts/${provider}`,jsonInit('PUT',body));
}
export function saveSocialPreferences(provider:SocialProvider,patch:SocialPreferencePatch):Promise<SocialAccount> {
  const {permissions,allowlistEnabled,allowlist,proactivePolicy,groupAllowlist}=patch;
  return apiJson(`/api/social/accounts/${provider}`,jsonInit('PUT',{permissions,allowlistEnabled,allowlist,proactivePolicy,groupAllowlist}));
}
// Each provider has one write order even when a modal or settings page unmounts.
const preferenceWriters=new Map<SocialProvider,ReturnType<typeof createSocialPreferenceWriter<SocialAccount>>>();
export function socialPreferenceWriter(provider:SocialProvider){
  let writer=preferenceWriters.get(provider);
  if(!writer){
    writer=createSocialPreferenceWriter({save:patch=>saveSocialPreferences(provider,patch),read:async()=>{
      const next=(await socialAccounts()).accounts.find(account=>account.provider===provider);
      if(!next)throw new Error('Missing account');return next;
    }});
    preferenceWriters.set(provider,writer);
  }
  return writer;
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

export interface QQMedia {mediaId:string;name:string;mime:string;size:number}
export function qqMedia(signal?:AbortSignal):Promise<{items:QQMedia[]}>{
  return apiJson('/api/social/accounts/qq/media',{signal});
}
export function uploadQQMedia(file:File,signal?:AbortSignal):Promise<QQMedia>{
  const body=new FormData();body.append('file',file);
  return apiJson('/api/social/accounts/qq/media',{method:'POST',body,signal});
}
export function removeQQMedia(mediaId:string,signal?:AbortSignal):Promise<unknown>{
  return apiJson(`/api/social/accounts/qq/media/${encodeURIComponent(mediaId)}`,{method:'DELETE',signal});
}
