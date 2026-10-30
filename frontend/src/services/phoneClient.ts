import {apiJson} from './http';
export interface PhoneMessage {id:string;text:string;direction:'in'|'out';speaker:string;status:string;at:string}
export interface PhoneSnapshot {
 apps:{id:string;provider:string;name:string;enabled:boolean;pending:number}[];accountKey:string;pending:number;
 conversations:{id:string;kind:'private'|'group';pending:number;preview:string}[];
 messages:PhoneMessage[];operations:{id:string;status:string;action:string}[];hasMore:boolean;nextBefore:number|null;
 activity:{runId?:string;peerId?:string;source:string;toolSource?:string;accountId?:string}|null;
}
export function phoneSnapshot(peer?:string,before?:number,signal?:AbortSignal,app='momo-qq'):Promise<PhoneSnapshot>{
 const params=new URLSearchParams({app});if(peer)params.set('peer',peer);if(before!==undefined)params.set('before',String(before));
 return apiJson('/api/phone?'+params,{signal});
}
