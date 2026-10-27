/** Exact aliases for the one loopback-only Web development listener. */
export function localWebOrigins(configured?:string):Set<string>{
  const selected=/^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/.exec(configured??'');
  if(!selected||selected[0]!==configured||Number(selected[1])>65535)return new Set();
  return new Set([`http://127.0.0.1:${selected[1]}`,`http://localhost:${selected[1]}`]);
}
export function guardWebProxy(configured?:string){
  const origins=localWebOrigins(configured);
  return (outgoing:{removeHeader:(name:string)=>void},request:{headers:{origin?:string|string[]}})=>{
    const origin=request.headers.origin;
    if(origin!==undefined&&(typeof origin!=='string'||!origins.has(origin)))outgoing.removeHeader('x-momo-token');
  };
}
