import {apiJson} from './http';
export type GameTask={taskId:string;skill:string;state:'queued'|'running'|'paused'|'succeeded'|'failed'|'cancelled';reason:string;progress?:{skill?:string;action?:{skill?:string}}};
export type GameStatus={active:boolean;generation:number;paused:boolean;autonomous:boolean;decisionNeeded:boolean;tasks:GameTask[];goal:{title:string;status:string;next?:string}|null};
let snapshot:GameStatus|null=null,pending:Promise<GameStatus>|null=null,last=0;
const listeners=new Set<()=>void>();
export const subscribeMinecraft=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
export const minecraftSnapshot=()=>snapshot;
export function readMinecraftStatus():Promise<GameStatus>{
 if(pending)return pending;
 if(snapshot&&Date.now()-last<750)return Promise.resolve(snapshot);
 pending=apiJson<GameStatus>('/api/minecraft/status').then(value=>{snapshot=value;last=Date.now();listeners.forEach(fn=>fn());return value;}).finally(()=>{pending=null;});
 return pending;
}
