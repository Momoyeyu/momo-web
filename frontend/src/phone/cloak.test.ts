import {it,expect} from 'vitest';
import {cloakTiles} from './cloak';
it('bounds the mosaic envelope, with reproducible variation and both directions',()=>{
 const tiles=cloakTiles(1234);
 expect(tiles).toEqual(cloakTiles(1234));expect(tiles).not.toEqual(cloakTiles(1235));
 expect(tiles).toHaveLength(288);
 expect(tiles.some(t=>t.angle>10)).toBe(true);expect(tiles.some(t=>t.angle < -10)).toBe(true);
 expect(new Set(tiles.map(t=>t.delay)).size).toBeGreaterThan(40);
 expect(tiles.every(t=>t.duration+t.delay<=525&&t.duration<=175&&t.width>0&&t.height>0)).toBe(true);
});
