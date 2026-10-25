import {runtimeFetch} from './runtime';

interface Lease {clientId:string;leaseId:string;epoch:number;expiresAt:number}
type Failure='owned'|'unavailable';
type Snapshot = {state:'idle'|'entering'|'active'|'failed';lease:Lease|null;reason?:Failure};
class MeetingError extends Error {constructor(public reason:Failure){super('Meeting is unavailable');}}
const STORAGE='momo.meeting-owner.v1';
const listeners=new Set<()=>void>();
let snapshot:Snapshot={state:'idle',lease:null};
let clientId:string|null=null;
let pending:Promise<Lease>|null=null;
let departing:Promise<void>|null=null;
let generation=0;
let heartbeatTimer:ReturnType<typeof setTimeout>|null=null;
let expiryTimer:ReturnType<typeof setTimeout>|null=null;
function stored():Partial<Lease>|null {
  try {return JSON.parse(sessionStorage.getItem(STORAGE)||'null') as Partial<Lease>|null;} catch {return null;}
}
function write(lease:Lease|null):void {
  try {
    if (lease) sessionStorage.setItem(STORAGE,JSON.stringify({clientId:lease.clientId,leaseId:lease.leaseId}));
    else sessionStorage.removeItem(STORAGE);
  } catch { /* Restricted browser storage still permits this window's meeting. */ }
}
function publish(next:Snapshot):void {snapshot=next;for(const listener of listeners)listener();}
function clearTimers():void {
  if(heartbeatTimer)clearTimeout(heartbeatTimer);
  if(expiryTimer)clearTimeout(expiryTimer);
  heartbeatTimer=null;expiryTimer=null;
}
function fail(reason:Failure='unavailable'):void {clearTimers();write(null);publish({state:'failed',lease:null,reason});}
export function meetingSnapshot():Snapshot{return snapshot;}
export function subscribeMeeting(listener:()=>void):()=>void {listeners.add(listener);return()=>listeners.delete(listener);}
export function meetingIdentity():{clientId:string;leaseId:string}|undefined {
  const lease=snapshot.lease;
  if(snapshot.state!=='active'||!lease||lease.expiresAt<=Date.now())return undefined;
  return {clientId:lease.clientId,leaseId:lease.leaseId};
}
async function post(path:string,body:unknown):Promise<Response>{
  const response=await runtimeFetch(`/api/meeting/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),keepalive:true,signal:AbortSignal.timeout(8000)});
  if(!response.ok){
    const body=await response.json().catch(()=>null) as {detail?:unknown}|null;
    const owned=typeof body?.detail==='string' && /Another window|meeting_owned/i.test(body.detail);
    throw new MeetingError(owned?'owned':'unavailable');
  }
  return response;
}
function parseLease(data:unknown,id:string):Lease {
  const value=data as {leaseId?:unknown;epoch?:unknown;expiresIn?:unknown};
  if(!value||typeof value.leaseId!=='string'||typeof value.epoch!=='number'||typeof value.expiresIn!=='number'||value.expiresIn<=0)throw new Error('Invalid meeting lease');
  return {clientId:id,leaseId:value.leaseId,epoch:value.epoch,expiresAt:Date.now()+value.expiresIn*1000};
}
function schedule(lease:Lease,version:number):void {
  clearTimers();
  const remaining=lease.expiresAt-Date.now();
  expiryTimer=setTimeout(()=>{if(version===generation)fail();},remaining);
  heartbeatTimer=setTimeout(()=>void heartbeat(version),Math.max(500,Math.min(5000,remaining/3)));
}
async function heartbeat(version:number):Promise<void>{
  const lease=snapshot.lease;
  if(!lease||version!==generation)return;
  try {
    const response=await post('heartbeat',{clientId:lease.clientId,leaseId:lease.leaseId});
    const renewed=parseLease(await response.json(),lease.clientId);
    if(version!==generation||snapshot.state!=='active')return;
    write(renewed);publish({state:'active',lease:renewed});schedule(renewed,version);
  }catch(error){if(version===generation)fail(error instanceof MeetingError?error.reason:'unavailable');}
}
/** The App owns one meeting through chat/settings/backlog. Enter is a server gate. */
export function enterMeeting():Promise<Lease>{
  if(departing)return departing.then(()=>enterMeeting());
  const active=snapshot.lease;
  if(snapshot.state==='active'&&active&&active.expiresAt>Date.now())return Promise.resolve(active);
  if(pending)return pending;
  const saved=stored();
  clientId??=typeof saved?.clientId==='string'?saved.clientId:crypto.randomUUID();
  const id=clientId,version=++generation;
  publish({state:'entering',lease:null});
  const request=post('enter',{clientId:id,...(typeof saved?.leaseId==='string'?{leaseId:saved.leaseId}:{})}).then(async response=>{
    const lease=parseLease(await response.json(),id);
    if(version!==generation){await post('leave',{clientId:lease.clientId,leaseId:lease.leaseId}).catch(()=>undefined);throw new Error('Meeting entry superseded');}
    write(lease);publish({state:'active',lease});schedule(lease,version);
    return lease;
  }).catch(error=>{if(version===generation)fail(error instanceof MeetingError?error.reason:'unavailable');throw error;}).finally(()=>{if(pending===request)pending=null;});
  pending=request;return request;
}
export function leaveMeeting(after:Promise<unknown>=Promise.resolve()):Promise<void>{
  if(departing)return departing;
  const entering=pending,lease=snapshot.lease;
  generation++;pending=null;clearTimers();write(null);publish({state:'idle',lease:null});
  const operation=(async()=>{
    // Keep the old server lease alive long enough to persist the observed prefix.
    await after.catch(()=>undefined);
    let identity=lease;
    if(!identity&&entering){try{identity=await entering;}catch{/* Superseded entry releases itself. */}}
    if(identity)await post('leave',{clientId:identity.clientId,leaseId:identity.leaseId}).catch(()=>undefined);
  })().finally(()=>{if(departing===operation)departing=null;});
  departing=operation;return operation;
}
/** Test isolation: the production singleton otherwise lives for one document. */
export function resetMeetingClient():void {generation++;pending=null;departing=null;clientId=null;clearTimers();write(null);snapshot={state:'idle',lease:null};}
