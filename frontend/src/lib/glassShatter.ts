export interface Point {x:number;y:number}
export interface Shard {
  polygon:Point[];center:Point;delay:number;spin:number;drift:number;tilt:number;thickness:number;
}
export const CRACK_MS=320,BREAK_MS=210,FALL_MS=650;
export const SHATTER_MS=CRACK_MS+BREAK_MS+FALL_MS;
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
export function glassPhase(elapsed:number){return elapsed<CRACK_MS?'cracking':elapsed<CRACK_MS+BREAK_MS?'breaking':'falling';}

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
      spin:(random()-.5)*2.3,drift:(site.x-.5)*.2+(random()-.5)*.12,
      tilt:(.7+random()*1.25)*(random()>.5?1:-1),thickness:2+random()*2};
  });
}

/** Intact cracks first, then separation without falling, then gravity. */
export function shardPose(shard:Shard,progress:number){
  const ms=progress*SHATTER_MS;
  const split=clamp((ms-CRACK_MS)/BREAK_MS),delay=shard.delay*FALL_MS*.3;
  const t=clamp((ms-CRACK_MS-BREAK_MS-delay)/(FALL_MS-delay));
  const yaw=shard.tilt*(split*.12+t*.88),shrink=1-.035*split;
  return {x:shard.drift*(split*.025+t),y:1.8*t*t,angle:shard.spin*(split*.025+t*t),
    scaleX:Math.cos(yaw)*shrink,scaleY:(1-.08*t)*shrink,skew:Math.sin(yaw)*.13,
    yaw,split,fall:t,alpha:1-clamp((t-.8)/.2)};
}

/** Unique shared edges, ordered outwards from the impact for growing cracks. */
export function glassCracks(shards:Shard[]){
 const edges=new Map<string,{a:Point;b:Point;order:number}>();
 for(const {polygon} of shards)for(let i=0;i<polygon.length;i++){
  let a=polygon[i],b=polygon[(i+1)%polygon.length];
  if((Math.abs(a.x-b.x)<1e-9&&(a.x<1e-9||a.x>1-1e-9))||(Math.abs(a.y-b.y)<1e-9&&(a.y<1e-9||a.y>1-1e-9)))continue;
  const distance=(p:Point)=>Math.hypot((p.x-.64)*1.5,p.y-.39);
  if(distance(a)>distance(b))[a,b]=[b,a];
  const keys=[`${a.x.toFixed(6)},${a.y.toFixed(6)}`,`${b.x.toFixed(6)},${b.y.toFixed(6)}`].sort();
  edges.set(keys.join('|'),{a,b,order:Math.min(.8,distance(a)*.85)});
 }
 return [...edges.values()];
}
