import {SOCIAL_PERMISSIONS,type SocialPeer,type SocialPermissions,type SocialProactivePolicy} from './socialClient';
export interface SocialPreferencePatch {
  permissions?:Partial<SocialPermissions>;
  allowlistEnabled?:boolean;
  allowlist?:SocialPeer[];
  groupAllowlist?:SocialPeer[];
  proactivePolicy?:Partial<SocialProactivePolicy>;
}

function project(value:SocialPreferencePatch):SocialPreferencePatch {
  const patch:SocialPreferencePatch={};
  if(value.permissions){
    const permissions:Partial<SocialPermissions>={};
    for(const key of SOCIAL_PERMISSIONS)if(typeof value.permissions[key]==='boolean')permissions[key]=value.permissions[key];
    if(Object.keys(permissions).length)patch.permissions=permissions;
  }
  if(typeof value.allowlistEnabled==='boolean')patch.allowlistEnabled=value.allowlistEnabled;
  if(Array.isArray(value.allowlist))patch.allowlist=value.allowlist.map(({peerId})=>({peerId}));
  if(Array.isArray(value.groupAllowlist))patch.groupAllowlist=value.groupAllowlist.map(({peerId})=>({peerId}));
  if(value.proactivePolicy){
    const source=value.proactivePolicy;const policy:Partial<SocialProactivePolicy>={};
    if(Array.isArray(source.recipientIds))policy.recipientIds=[...source.recipientIds];
    for(const key of ['maxPerHour','minIntervalSeconds','quietStart','quietEnd'] as const)if(Number.isInteger(source[key]))policy[key]=source[key];
    if(Object.keys(policy).length)patch.proactivePolicy=policy;
  }
  return patch;
}
export function mergePreferencePatches(left:SocialPreferencePatch,right:SocialPreferencePatch):SocialPreferencePatch {
  return {...left,...right,...(left.permissions||right.permissions?{permissions:{...left.permissions,...right.permissions}}:{}),...(left.proactivePolicy||right.proactivePolicy?{proactivePolicy:{...left.proactivePolicy,...right.proactivePolicy}}:{})};
}
export interface SocialPreferenceObserver<T> {
  onSettled:(actual:T,pending:SocialPreferencePatch)=>void;
  onError:(failed:boolean)=>void;
  onBusy:(busy:boolean)=>void;
}
/** A coordinator outlives its editors; subscribers own views, never queued writes. */
export function createSocialPreferenceWriter<T>({save,read,onSettled,onError,onBusy,delayMs=300}:{
  save:(patch:SocialPreferencePatch)=>Promise<T>;read:()=>Promise<T>;
  onSettled?:SocialPreferenceObserver<T>['onSettled'];onError?:SocialPreferenceObserver<T>['onError'];onBusy?:SocialPreferenceObserver<T>['onBusy'];delayMs?:number;
}){
  let pending:SocialPreferencePatch={};let running:Promise<void>|null=null;let timer:ReturnType<typeof setTimeout>|undefined;
  let failed=false;
  const observers=new Set<SocialPreferenceObserver<T>>();
  if(onSettled||onError||onBusy)observers.add({onSettled:onSettled??(()=>{}),onError:onError??(()=>{}),onBusy:onBusy??(()=>{})});
  const busy=(value:boolean)=>{for(const observer of observers)observer.onBusy(value);};
  const error=(value:boolean)=>{failed=value;for(const observer of observers)observer.onError(value);};
  const settled=(actual:T)=>{for(const observer of observers)observer.onSettled(actual,pending);};
  const flush=():Promise<void>=>{
    clearTimeout(timer);
    if(running)return running;
    if(!Object.keys(pending).length)return Promise.resolve();
    running=(async()=>{
      while(Object.keys(pending).length){
        const patch=pending;pending={};
        try{const actual=await save(patch);error(false);settled(actual);}
        catch{error(true);try{settled(await read());}catch{/* Keep the error visible when current configuration cannot be read. */}}
      }
    })().finally(()=>{running=null;busy(false);});
    return running;
  };
  return {
    patch(value:SocialPreferencePatch){
      const safe=project(value);if(!Object.keys(safe).length)return;
      pending=mergePreferencePatches(pending,safe);busy(true);clearTimeout(timer);
      timer=setTimeout(()=>{void flush();},delayMs);
    },
    flush,
    subscribe(observer:SocialPreferenceObserver<T>){
      observers.add(observer);observer.onBusy(running!==null||Object.keys(pending).length>0);observer.onError(failed);
      return()=>{observers.delete(observer);};
    },
  };
}
