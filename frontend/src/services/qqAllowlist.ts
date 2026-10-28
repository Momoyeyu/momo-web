import type {SocialPeer} from './socialClient';
/** Validate the whole explicit Add action before changing saved policy. */
export function addQQContacts(input:string,existing:SocialPeer[]):SocialPeer[]{
 const ids=input.trim().split(/[\s,，;；、]+/u).filter(Boolean);
 if(!ids.length||ids.some(id=>!/^[1-9][0-9]{4,11}$/.test(id)))throw new Error('invalid');
 const seen=new Set(existing.map(peer=>peer.peerId));
 for(const id of ids){if(seen.has(id))throw new Error('duplicate');seen.add(id);}
 if(seen.size>200)throw new Error('limit');
 return [...existing,...ids.map(peerId=>({peerId}))];
}
