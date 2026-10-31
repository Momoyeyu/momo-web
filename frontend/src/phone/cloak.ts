/** Seeded sampling: one pattern per transition, stable while messages update. */
export function cloakTiles(seed:number){
 let state=seed>>>0;
 const uniform=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return (state+.5)/4294967296;};
 const normal=()=>Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform());
 const clamp=(x:number,a:number,b:number)=>Math.min(b,Math.max(a,x));
 return Array.from({length:288},(_,i)=>{
  const x=i%12,y=Math.floor(i/12),distance=Math.hypot((x-5.5)/12,(y-11.5)/24);
  return {x,y,width:clamp(1+normal()*.2,.65,1.55),height:clamp(1+normal()*.25,.6,1.6),
   angle:clamp(normal()*19,-42,42),skew:clamp(normal()*23,-38,38),
   dx:clamp(normal()*19,-46,46),dy:clamp(normal()*12,-30,30),
   delay:Math.round(clamp(distance*300+normal()*70+70,0,350)),duration:Math.round(clamp(115+normal()*24,65,175)),
   light:clamp(.3+uniform()*.5,.3,.8)};
 });
}
