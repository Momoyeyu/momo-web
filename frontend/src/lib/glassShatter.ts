export interface Point {x:number;y:number}
export interface Shard {
  polygon:Point[];center:Point;delay:number;spin:number;drift:number;tilt:number;thickness:number;
}
export const CRACK_SPREAD_MS=480,CRACK_MS=640,BREAK_MS=280,FALL_MS=680;
export const SHATTER_MS=CRACK_MS+BREAK_MS+FALL_MS;
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
export function glassPhase(elapsed:number){return elapsed<CRACK_MS?'cracking':elapsed<CRACK_MS+BREAK_MS?'breaking':'falling';}

/** Radial stress fractures, cross-cracks and a few sharp splinters.
 * Shared ring vertices tile the entire rectangle, including its four corners. */
export function glassShards(seed=1):Shard[]{
  let state=seed>>>0;
  const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
  const origin={x:.64,y:.39},aspect=1.6;
  const corners=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
  const angles=corners.map(p=>Math.atan2(p.y-origin.y,(p.x-origin.x)*aspect));
  for(let i=0;i<12;i++){
    const angle=-Math.PI+(i+.2+random()*.6)*Math.PI*2/12;
    if(angles.every(other=>Math.abs(Math.atan2(Math.sin(angle-other),Math.cos(angle-other)))>.065))angles.push(angle);
  }
  angles.sort((a,b)=>a-b);
  const rings=angles.map(angle=>{
    const dx=Math.cos(angle)/aspect,dy=Math.sin(angle);
    const reach=Math.min(dx>0?(1-origin.x)/dx:dx<0?-origin.x/dx:Infinity,dy>0?(1-origin.y)/dy:dy<0?-origin.y/dy:Infinity);
    return [0,.13,.37,.68,1].map((fraction,ring)=>{
      const r=ring===0||ring===4?fraction:fraction+(random()-.5)*.09;
      return {x:clamp(origin.x+dx*reach*r),y:clamp(origin.y+dy*reach*r)};
    });
  });
  const polygons:Point[][]=[];
  for(let sector=0;sector<rings.length;sector++)for(let ring=0;ring<4;ring++){
    const a=rings[sector],b=rings[(sector+1)%rings.length];
    if(ring===0)polygons.push([origin,a[1],b[1]]);
    else if(random()<.3)polygons.push([a[ring],a[ring+1],b[ring+1]],[a[ring],b[ring+1],b[ring]]);
    else polygons.push([a[ring],a[ring+1],b[ring+1],b[ring]]);
  }
  return polygons.map(polygon=>{
    const center={x:polygon.reduce((s,p)=>s+p.x,0)/polygon.length,y:polygon.reduce((s,p)=>s+p.y,0)/polygon.length};
    return {polygon,center,delay:.055+Math.hypot(center.x-origin.x,center.y-origin.y)*.16+random()*.07,
      spin:(random()-.5)*2.1,drift:(center.x-.5)*.2+(random()-.5)*.12,
      tilt:(.9+random()*1.25)*(random()>.5?1:-1),thickness:4.5+random()*2.5};
  });
}

/** Intact cracks first, then separation without falling, then gravity. */
export function shardPose(shard:Shard,progress:number){
  const ms=progress*SHATTER_MS;
  const split=clamp((ms-CRACK_MS)/BREAK_MS),delay=shard.delay*FALL_MS*.3;
  const t=clamp((ms-CRACK_MS-BREAK_MS-delay)/(FALL_MS-delay));
  const yaw=shard.tilt*(split*.3+t*.7),shrink=1-.07*split;
  return {x:shard.drift*(split*.065+t),y:1.8*t*t,angle:shard.spin*(split*.075+t*t),
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
