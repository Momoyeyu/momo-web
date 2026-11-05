import {it,expect} from 'vitest';
import {roomPhase} from './roomTime';
it('uses local 24-hour boundaries including midnight',()=>{
 for(const [h,p] of [[0,'night'],[4,'night'],[5,'morning'],[9,'morning'],[10,'day'],[16,'day'],[17,'evening'],[19,'evening'],[20,'night'],[23,'night']] as const)expect(roomPhase(h)).toBe(p);
});
