import {describe,it,expect} from 'vitest';
import {glassCracks,glassPhase,glassShards,shardPose,CRACK_MS,BREAK_MS,SHATTER_MS} from './glassShatter';
describe('glass pane geometry',()=>{
 it('tiles the whole pane with bounded convex fragments, reproducibly',()=>{
  const shards=glassShards(42);
  expect(shards).toEqual(glassShards(42));expect(shards).not.toEqual(glassShards(43));
  const area=shards.reduce((sum,s)=>sum+Math.abs(s.polygon.reduce((a,p,i)=>{const q=s.polygon[(i+1)%s.polygon.length];return a+p.x*q.y-q.x*p.y;},0))/2,0);
  expect(area).toBeCloseTo(1,9);
  for(const shard of shards){expect(shard.polygon.length).toBeGreaterThanOrEqual(3);for(const p of shard.polygon){expect(p.x).toBeGreaterThanOrEqual(-1e-12);expect(p.x).toBeLessThanOrEqual(1+1e-12);expect(p.y).toBeGreaterThanOrEqual(-1e-12);expect(p.y).toBeLessThanOrEqual(1+1e-12);}}
 });
 it('keeps cracks intact, separates before gravity and deduplicates shared cracks',()=>{
  const shards=glassShards(17),edges=glassCracks(shards);
  expect(edges.length).toBeGreaterThan(100);
  const keys=edges.map(({a,b})=>[`${a.x.toFixed(6)},${a.y.toFixed(6)}`,`${b.x.toFixed(6)},${b.y.toFixed(6)}`].sort().join('|'));
  expect(new Set(keys).size).toBe(keys.length);
  expect(glassPhase(CRACK_MS-1)).toBe('cracking');expect(glassPhase(CRACK_MS)).toBe('breaking');expect(glassPhase(CRACK_MS+BREAK_MS)).toBe('falling');
  for(const shard of shards){
   const crack=shardPose(shard,(CRACK_MS-1)/SHATTER_MS);
   expect(crack.y).toBe(0);expect(crack.scaleX).toBe(1);expect(crack.scaleY).toBe(1);expect(crack.split).toBe(0);
   const split=shardPose(shard,(CRACK_MS+BREAK_MS-1)/SHATTER_MS);
   expect(split.y).toBe(0);expect(split.scaleX).toBeLessThan(1);expect(split.split).toBeGreaterThan(.99);
   expect(shardPose(shard,.75).y).toBeGreaterThan(0);
  }
 });
 it('starts assembled, falls downward and fully clears at the deadline',()=>{
  for(const shard of glassShards(13)){
   const start=shardPose(shard,0);expect(start.x).toBeCloseTo(0);expect(start.angle).toBeCloseTo(0);expect(start.y).toBe(0);expect(start.alpha).toBe(1);
   let previous=0;
   for(let p=0;p<=1;p+=.05){const pose=shardPose(shard,p);expect(pose.y).toBeGreaterThanOrEqual(previous);previous=pose.y;}
   expect(shardPose(shard,1).y).toBeGreaterThan(1.5);expect(shardPose(shard,1).alpha).toBeCloseTo(0,12);
  }
 });
});
