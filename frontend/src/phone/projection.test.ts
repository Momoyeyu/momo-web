import {it,expect} from 'vitest';
import {phoneIdentityChanged,mergePhoneMessages} from './projection';
import type {PhoneMessage} from '../services/phoneClient';
it('switches apps without confusing their independent logins',()=>{
 expect(phoneIdentityChanged('["qq","one"]','["notes","two"]')).toBe(false);
 expect(phoneIdentityChanged('["qq","one"]','["qq","two"]')).toBe(true);
});
it('retains displaced latest messages and updates receipts',()=>{
 const m=(id:number,status='received'):PhoneMessage=>({id:String(id),status,text:String(id),direction:'in',speaker:'test',at:'t'});
 const first=Array.from({length:30},(_,i)=>m(i+1));
 const updated=mergePhoneMessages(first,Array.from({length:30},(_,i)=>m(i+2,'processing')));
 expect(updated).toHaveLength(31);
 expect(updated[0].id).toBe('1');expect(updated[1].status).toBe('processing');
});
