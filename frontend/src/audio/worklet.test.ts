import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect,it} from 'vitest';
it('pauses PCM consumption and resumes the same sample without draining',()=>{
  let Processor!:new()=>{port:{onmessage: (event:{data:unknown})=>void};process: (_input:unknown,output:Float32Array[][])=>boolean};
  const messages:unknown[]=[];
  runInNewContext(readFileSync(new URL('../../public/worklets/pcm-player.js',import.meta.url),'utf8'),{
    AudioWorkletProcessor:class {port={onmessage:()=>{},postMessage:(message:unknown)=>messages.push(message)};},
    registerProcessor:(_name:string,value:typeof Processor)=>{Processor=value;},
    Float32Array,Math,
  });
  const processor=new Processor();
  processor.port.onmessage({data:{type:'push',samples:new Float32Array([.1,.2,.3,.4])}});
  const first=new Float32Array(1);processor.process([],[[first]]);
  expect(first[0]).toBeCloseTo(.1);
  processor.port.onmessage({data:{type:'pause',paused:true}});
  const held=new Float32Array(2);processor.process([],[[held]]);
  expect([...held]).toEqual([0,0]);
  expect(messages).not.toContainEqual({type:'drain'});
  processor.port.onmessage({data:{type:'pause',paused:false}});
  const next=new Float32Array(2);processor.process([],[[next]]);
  expect(next[0]).toBeCloseTo(.2);expect(next[1]).toBeCloseTo(.3);
});
