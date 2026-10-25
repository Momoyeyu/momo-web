import {describe,it,expect} from 'vitest';
import {inkCells,inkFrame} from './presenceTransition';

describe('presence ink entry',()=>{
  it('keeps transparent background empty and retains the three internal inks',()=>{
    const cells=inkCells({width:2,height:2,data:new Uint8ClampedArray([
      231,190,119,255,243,236,223,255,24,21,31,255,231,190,119,0,
    ])});
    expect(cells.map(cell=>cell.ink)).toEqual([0,1,2]);
    expect(cells.map(cell=>cell.id)).toEqual([0,1,2]);
  });
  it('retains cell identity when revisiting a frame and always clears at completion',()=>{
    const image={width:3,height:1,data:new Uint8ClampedArray([
      231,190,119,255,243,236,223,255,24,21,31,255,
    ])};
    const first=inkCells(image),again=inkCells(image);
    expect(again).toEqual(first);
    for(const cell of first){
      const middle=inkFrame(cell,.5,1280,720);
      expect(middle.alpha).toBeGreaterThan(0);
      expect(inkFrame(cell,.5,1280,720)).toEqual(middle);
      expect(inkFrame(cell,1,1280,720).alpha).toBe(0);
      const final=inkFrame(cell,1,1280,720);
      expect(final.x).toBeGreaterThanOrEqual(0);expect(final.x).toBeLessThanOrEqual(1280);
      expect(final.y).toBeGreaterThanOrEqual(0);expect(final.y).toBeLessThanOrEqual(720);
    }
  });
});
