import {runtimeFetch} from './runtime';

interface Lease {clientId:string;leaseId:string;epoch:number;expiresAt:number}
export interface AttentionState {
  activation:'active'|'dormant'|'fault';
  focus:boolean;
  phonePaused:boolean;
  busy:boolean;
  activity:{runId:string;source:string;accountId?:string;phase:string;toolSource?:string}|null;
  presentation:{runId:string;token:string;generation:number}|null;
}
const DORMANT:AttentionState={activation:'dormant',focus:false,phonePaused:false,busy:false,activity:null,presentation:null};
type Failure='owned'|'unavailable';
export type MeetingSnapshot = {state:'idle'|'entering'|'active'|'failed';lease:Lease|null;reason?:Failure;attention:AttentionState};
class MeetingError extends Error {constructor(public reason:Failure){super('Meeting is unavailable');}}
const STORAGE='momo.meeting-owner.v1';
const listeners=new Set<()=>void>();
let snapshot:MeetingSnapshot={state:'idle',lease:null,attention:DORMANT};
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
function publish(next:MeetingSnapshot):void {snapshot=next;for(const listener of listeners)listener();}
function attentionOf(data:unknown):AttentionState {
  const value=data as Partial<AttentionState>;
  return {activation:value.activation??'active',focus:!!value.focus,phonePaused:!!value.phonePaused,busy:!!value.busy,activity:value.activity??null,presentation:value.presentation??null};
}
function clearTimers():void {
  if(heartbeatTimer)clearTimeout(heartbeatTimer);
  if(expiryTimer)clearTimeout(expiryTimer);
  heartbeatTimer=null;expiryTimer=null;
}
function fail(reason:Failure='unavailable',retainStoredIdentity=false):void {clearTimers();if(!retainStoredIdentity)write(null);publish({state:'failed',lease:null,reason,attention:{...DORMANT,activation:'fault'}});}
/** Only an existing owner capability restores a meeting on subpage refresh. */
export function storedMeetingIdentity():{clientId:string;leaseId:string}|undefined {
  const value=stored();
  return typeof value?.clientId==='string'&&typeof value.leaseId==='string'
    ? {clientId:value.clientId,leaseId:value.leaseId}:undefined;
}
export function meetingSnapshot():MeetingSnapshot{return snapshot;}
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
  let data:unknown;
  try {
    const response=await post('heartbeat',{clientId:lease.clientId,leaseId:lease.leaseId});
    data=await response.json();
  }catch(error){
    // Reload can cancel a response body before the old document is destroyed.
    // Disable local sending, but retain proof for a new server-validated restore.
    if(version===generation)fail(error instanceof MeetingError?error.reason:'unavailable',!(error instanceof MeetingError));
    return;
  }
  try {
    const renewed=parseLease(data,lease.clientId);
    if(version!==generation||snapshot.state!=='active')return;
    write(renewed);publish({state:'active',lease:renewed,attention:attentionOf(data)});schedule(renewed,version);
  }catch{if(version===generation)fail();}
}
/** The App owns one meeting through chat/settings/backlog. Enter is a server gate. */
export function enterMeeting(restore=false):Promise<Lease>{
  if(departing)return departing.then(()=>enterMeeting(restore));
  const active=snapshot.lease;
  if(snapshot.state==='active'&&active&&active.expiresAt>Date.now())return Promise.resolve(active);
  if(pending)return pending;
  const saved=stored();
  if(restore && !storedMeetingIdentity())return Promise.reject(new MeetingError('unavailable'));
  clientId??=typeof saved?.clientId==='string'?saved.clientId:crypto.randomUUID();
  const id=clientId,version=++generation;
  publish({state:'entering',lease:null,attention:DORMANT});
  const request=post('enter',{clientId:id,...(typeof saved?.leaseId==='string'?{leaseId:saved.leaseId}:{}),...(restore?{restore:true}:{})}).then(async response=>{
    const data:unknown=await response.json();
    const lease=parseLease(data,id);
    if(version!==generation){await post('leave',{clientId:lease.clientId,leaseId:lease.leaseId}).catch(()=>undefined);throw new Error('Meeting entry superseded');}
    write(lease);publish({state:'active',lease,attention:attentionOf(data)});schedule(lease,version);
    return lease;
  }).catch(error=>{if(version===generation)fail(error instanceof MeetingError?error.reason:'unavailable');throw error;}).finally(()=>{if(pending===request)pending=null;});
  pending=request;return request;
}
export function leaveMeeting(after:Promise<unknown>=Promise.resolve()):Promise<void>{
  if(departing)return departing;
  const entering=pending,lease=snapshot.lease??storedMeetingIdentity();
  generation++;pending=null;clearTimers();write(null);publish({state:'idle',lease:null,attention:DORMANT});
  const operation=(async()=>{
    // Keep the old server lease alive long enough to persist the observed prefix.
    await after.catch(()=>undefined);
    let identity:{clientId:string;leaseId:string}|undefined=lease;
    if(!identity&&entering){try{identity=await entering;}catch{/* Superseded entry releases itself. */}}
    if(identity)await post('leave',{clientId:identity.clientId,leaseId:identity.leaseId}).catch(()=>undefined);
  })().finally(()=>{if(departing===operation)departing=null;});
  departing=operation;return operation;
}
/** Test isolation: the production singleton otherwise lives for one document. */
export function resetMeetingClient():void {generation++;pending=null;departing=null;clientId=null;clearTimers();write(null);snapshot={state:'idle',lease:null,attention:DORMANT};}

/** One App subscription refreshes attention; pages consume its snapshot as props. */
export async function refreshAttention(signal?:AbortSignal):Promise<void> {
  const lease=snapshot.lease;
  if(snapshot.state!=='active'||!lease)return;
  const version=generation;
  const response=await runtimeFetch('/api/meeting',{signal});
  if(!response.ok)throw new MeetingError('unavailable');
  const data:unknown=await response.json();
  if(version===generation && snapshot.lease?.leaseId===lease.leaseId)publish({...snapshot,attention:attentionOf(data)});
}
export async function controlAttention(action:'focus_on'|'focus_off'|'stop'|'resume_phone'|'use_phone'):Promise<void> {
  const owner=meetingIdentity();
  if(!owner)throw new MeetingError('unavailable');
  await post('control',{...owner,requestId:crypto.randomUUID(),action});
  await refreshAttention();
}
export async function acknowledgePresentation(runId:string,token:string,generation:number,outcome:'completed'|'stopped'|'resume',text:string,owner=meetingIdentity()):Promise<void> {
  if(!owner)throw new MeetingError('unavailable');
  await post('presentation',{...owner,runId,token,generation,outcome,text});
}
export async function acquireReplay(runId:string,eventId:string):Promise<{runId:string;token:string;generation:number;text:string}> {
  const owner=meetingIdentity();
  if(!owner)throw new MeetingError('unavailable');
  const response=await post('replay',{...owner,runId,eventId});
  const data=await response.json() as {presentation?:{runId:string;token:string;generation:number;text:string}};
  if(!data.presentation?.token)throw new MeetingError('unavailable');
  return data.presentation;
}
