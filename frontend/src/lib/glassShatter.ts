export interface Point {x:number;y:number}
export interface Shard {
  polygon:Point[];center:Point;delay:number;spin:number;drift:number;tilt:number;
}
export const SHATTER_MS=940;
const clamp=(n:number)=>Math.max(0,Math.min(1,n));

/** Bounded seeded Voronoi: shared bisectors tile the entire pane without gaps.
 * All coordinates are normalized; geometry is generated once, never per frame. */
export function glassShards(seed=1):Shard[]{
  let state=seed>>>0;
  const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
  const sites:Point[]=[];
  for(let row=0;row<6;row++)for(let col=0;col<10;col++)
    sites.push({x:(col+.16+random()*.68)/10,y:(row+.16+random()*.68)/6});
  // A denser fracture near the impact keeps the surface from reading as tiles.
  for(let i=0;i<12;i++){const angle=random()*Math.PI*2,r=.025+random()*.13;sites.push({x:.64+Math.cos(angle)*r,y:.39+Math.sin(angle)*r});}
  return sites.map((site,index)=>{
    let polygon:Point[]=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    for(let other=0;other<sites.length;other++){
      if(other===index)continue;
      const b=sites[other],nx=b.x-site.x,ny=b.y-site.y;
      const limit=(b.x*b.x+b.y*b.y-site.x*site.x-site.y*site.y)/2;
      const clipped:Point[]=[];
      for(let edge=0;edge<polygon.length;edge++){
        const a=polygon[edge],b=polygon[(edge+1)%polygon.length];
        const da=a.x*nx+a.y*ny-limit,db=b.x*nx+b.y*ny-limit;
        if(da<=0)clipped.push(a);
        if((da<=0)!==(db<=0)){const t=da/(da-db);clipped.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});}
      }
      polygon=clipped;
    }
    return {polygon,center:site,delay:.055+Math.hypot(site.x-.64,site.y-.39)*.16+random()*.07,
      spin:(random()-.5)*2.3,drift:(site.x-.5)*.2+(random()-.5)*.12,tilt:.5+random()*1.5};
  });
}

/** A short fracture hold, then gravity. Every shard clears the bottom by p=1. */
export function shardPose(shard:Shard,progress:number){
  const t=clamp((progress-shard.delay)/(1-shard.delay));
  return {x:shard.drift*t,y:1.8*t*t,angle:shard.spin*t*t,
    scaleX:Math.cos(shard.tilt*t)*(.999+.001*(1-t)),scaleY:1-.12*t,
    alpha:1-clamp((t-.8)/.2)};
}
