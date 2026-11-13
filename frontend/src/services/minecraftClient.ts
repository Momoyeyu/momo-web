import {apiJson} from './http';
export type GameTask={taskId:string;skill:string;state:'queued'|'running'|'paused'|'succeeded'|'failed'|'cancelled';reason:string;progress?:{skill?:string;action?:{skill?:string}}};
export type GameStatus={active:boolean;generation:number;permissions?:string[];paused:boolean;autonomous:boolean;decisionNeeded:boolean;tasks:GameTask[];goal:{title:string;status:string;next?:string}|null};
let snapshot:GameStatus|null=null,pending:Promise<GameStatus>|null=null,last=0;
let sequence=0;
const listeners=new Set<()=>void>();
export const subscribeMinecraft=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export const minecraftSnapshot=()=>snapshot;
export function readMinecraftStatus(force=false):Promise<GameStatus>{
 if(!force&&pending)return pending;
 if(!force&&snapshot&&Date.now()-last<750)return Promise.resolve(snapshot);
 const version=++sequence;
 pending=apiJson<GameStatus>('/api/minecraft/status').then(value=>{if(version===sequence){snapshot=value;last=Date.now();listeners.forEach(fn=>fn());}return value;}).finally(()=>{if(version===sequence)pending=null;});
 return pending;
}
