import {it,expect} from 'vitest';
import {gridReveal,phoneGridReveal} from './gridReveal';
import {ease} from './presenceTransition';
it('preserves the approved title print-front curve',()=>{
 for(const order of [0,.2,.5,.9,1])for(const p of [0,.34,.45,.6,.75,1])expect(gridReveal(order,p,.34,.36,.12)).toBeCloseTo(ease(.34+order*.36,.46+order*.36,p),12);
});
it('opens bottom to top and closes top to bottom along the same field',()=>{
 for(let row=0;row<12;row++){expect(phoneGridReveal(row,12,0)).toBe(0);expect(phoneGridReveal(row,12,1)).toBe(1);}
 expect(phoneGridReveal(11,12,.2)).toBeGreaterThan(0);expect(phoneGridReveal(0,12,.2)).toBe(0);
 expect(phoneGridReveal(11,12,.8)).toBe(1);expect(phoneGridReveal(0,12,.8)).toBeLessThan(1);
});
