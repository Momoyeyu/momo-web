import {describe, expect, it} from 'vitest';
import {localWebOrigins, guardWebProxy} from './web-origin';

describe('local Web proxy capabilities',()=>{
  it('accepts exactly the configured port under both loopback names',()=>{
    expect([...localWebOrigins('http://127.0.0.1:5177')].sort()).toEqual(['http://127.0.0.1:5177','http://localhost:5177']);
  });
  it('removes the outgoing capability for an untrusted origin, not just the incoming copy',()=>{
    const removed:string[]=[];
    const outgoing={removeHeader:(name:string)=>{removed.push(name);}};
    const guard=guardWebProxy('http://127.0.0.1:5177');
    for(const origin of ['http://localhost:5177','http://127.0.0.1:5177',undefined])guard(outgoing,{headers:{origin}});
    expect(removed).toEqual([]);
    for(const origin of ['http://localhost:5178','http://evil.example:5177','null',['http://localhost:5177']])guard(outgoing,{headers:{origin}});
    expect(removed).toEqual(Array(4).fill('x-momo-token'));
  });
  it('rejects malformed or noncanonical startup origins',()=>{
    for(const origin of ['http://127.0.0.1:5177/','http://user@127.0.0.1:5177','https://127.0.0.1:5177','http://127.0.0.1.evil:5177','http://127.0.0.1:0'])expect(localWebOrigins(origin).size).toBe(0);
  });
});
