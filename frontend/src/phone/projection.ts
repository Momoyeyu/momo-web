import type {PhoneMessage} from '../services/phoneClient';
/** App namespaces have independent identities; only a login change clears that view. */
export function phoneIdentityChanged(previous:string,next:string){
 if(!previous)return false;
 const [oldApp,oldAccount]=JSON.parse(previous),[app,account]=JSON.parse(next);
 return oldApp===app&&oldAccount!==account;
}
/** Polling updates receipts without dropping messages displaced from the latest page. */
export function mergePhoneMessages(previous:PhoneMessage[],next:PhoneMessage[]){
 return [...new Map([...previous,...next].map(m=>[m.id,m])).values()];
}
