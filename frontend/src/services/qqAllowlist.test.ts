import {describe,it,expect} from 'vitest';
import {addQQContacts} from './qqAllowlist';
describe('QQ allowlist input',()=>{
  it('accepts one number and pasted common separators without requiring newlines',()=>{
    expect(addQQContacts('12345，23456; 34567\n45678、56789',[])).toEqual(['12345','23456','34567','45678','56789'].map(peerId=>({peerId})));
  });
  it('rejects the entire batch on invalid syntax without altering existing entries',()=>{
    for(const input of ['abc','1234','012345','１２３４５','1234567890123','12345, bad',''])expect(()=>addQQContacts(input,[{peerId:'67890'}])).toThrow('invalid');
  });
  it('rejects duplicates and list overflow',()=>{
    expect(()=>addQQContacts('12345',[{peerId:'12345'}])).toThrow('duplicate');
    expect(()=>addQQContacts('12345 12345',[])).toThrow('duplicate');
    expect(()=>addQQContacts('99999',Array.from({length:200},(_,i)=>({peerId:String(10000+i)})))).toThrow('limit');
  });
});
