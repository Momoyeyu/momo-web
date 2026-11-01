import {describe,it,expect} from 'vitest';
import {glassShards,shardPose} from './glassShatter';
describe('glass pane geometry',()=>{
 it('tiles the whole pane with bounded convex fragments, reproducibly',()=>{
  const shards=glassShards(42);
  expect(shards).toEqual(glassShards(42));expect(shards).not.toEqual(glassShards(43));
  const area=shards.reduce((sum,s)=>sum+Math.abs(s.polygon.reduce((a,p,i)=>{const q=s.polygon[(i+1)%s.polygon.length];return a+p.x*q.y-q.x*p.y;},0))/2,0);
  expect(area).toBeCloseTo(1,9);
  for(const shard of shards){expect(shard.polygon.length).toBeGreaterThanOrEqual(3);for(const p of shard.polygon){expect(p.x).toBeGreaterThanOrEqual(-1e-12);expect(p.x).toBeLessThanOrEqual(1+1e-12);expect(p.y).toBeGreaterThanOrEqual(-1e-12);expect(p.y).toBeLessThanOrEqual(1+1e-12);}}
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
