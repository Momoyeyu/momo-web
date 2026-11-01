import {it,expect} from 'vitest';
import {mosaicFrame} from './digitalMosaic';
const palette=[[30,25,40],[230,190,120],[240,235,225]] as const;
const frame=(p:number,seed=42)=>mosaicFrame(48,96,240,480,p,seed,palette);
it('reconstructs from transparent cells to original content with no remaining tint',()=>{
 const empty=frame(0),full=frame(1);
 for(let i=0;i<empty.map.length;i+=4){expect(empty.map[i+2]).toBe(0);expect(full.map[i+2]).toBe(255);expect(full.map[i]).toBe(128);expect(full.map[i+1]).toBe(128);expect(full.color[i+3]).toBe(0);}
});
it('uses one seeded field in both directions, with local detail and color',()=>{
 const a=frame(.4);expect(a).toEqual(frame(.4));expect(a).not.toEqual(frame(.4,43));
 const alpha=Array.from(a.map).filter((_,i)=>i%4===2);
 expect(alpha.some(v=>v===0)).toBe(true);expect(alpha.some(v=>v===255)).toBe(true);
 expect(a.color).not.toEqual(frame(.5).color);
 const b=frame(.5);expect(a.map).not.toEqual(b.map); // flipping changes the cell projection, not just its color
});
