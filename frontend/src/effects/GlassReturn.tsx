import {useLayoutEffect,useRef} from 'react';
import {glassCracks,glassPhase,glassShards,shardPose,CRACK_MS,SHATTER_MS} from '../lib/glassShatter';
import './glassReturn.css';

/** The live pane cracks during capture. Only the prepared pane separates/falls. */
export default function GlassReturn({frame,seed,start,onComplete}:{frame:HTMLCanvasElement|null;seed:number;start:number;onComplete:()=>void}){
 const canvasRef=useRef<HTMLCanvasElement>(null),complete=useRef(onComplete),breakAt=useRef<number|null>(null);
 complete.current=onComplete;
 useLayoutEffect(()=>{
  const canvas=canvasRef.current;if(!canvas)return;
  const ctx=canvas.getContext('2d');
  let stopped=false,raf=0;
  const finish=()=>{if(stopped)return;stopped=true;cancelAnimationFrame(raf);complete.current();};
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const visibility=()=>{if(document.hidden)finish();};
  const preference=()=>{if(reduced.matches)finish();};
  // Capture is bounded separately; a hidden/throttled tab cannot trap Home.
  const deadline=window.setTimeout(finish,frame?SHATTER_MS+450:3200);
  const resize=()=>finish();
  document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',resize);reduced.addEventListener('change',preference);
  if(!ctx||document.hidden||reduced.matches)finish();
  else{
   const w=frame?.width??Math.round(Math.min(1280,canvas.clientWidth));
   const h=frame?.height??Math.round(w*canvas.clientHeight/canvas.clientWidth);
   canvas.width=w;canvas.height=h;
   const geometry=glassShards(seed),cracks=glassCracks(geometry);
   const shards=geometry.map((shard,index)=>{
    const points=shard.polygon.map(p=>({x:p.x*w,y:p.y*h}));
    const path=new Path2D();path.moveTo(points[0].x,points[0].y);for(const p of points.slice(1))path.lineTo(p.x,p.y);path.closePath();
    const left=Math.max(0,Math.floor(Math.min(...points.map(p=>p.x)))-1),top=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y)))-1);
    const width=Math.min(w-left,Math.ceil(Math.max(...points.map(p=>p.x)))-left+1),height=Math.min(h-top,Math.ceil(Math.max(...points.map(p=>p.y)))-top+1);
    // A cached spectrum per plane suggests daylight dispersion, not solid confetti.
    const reflection=ctx.createLinearGradient(left,top,left+width,top+height);
    [[0,'#e5f4ff00'],[.2,'#a8dfe800'],[.34,'#c0b7ee80'],[.46,'#f2ced87a'],[.55,'#ffe2ad80'],[.65,'#bfecd478'],[.77,'#c1dffc60'],[1,'#e5f4ff00']].forEach(([stop,color])=>reflection.addColorStop(Number(stop),String(color)));
    return {shard,index,points,path,left,top,width,height,reflection};
   });
   canvas.dataset.shards=String(shards.length);canvas.dataset.textured=String(!!frame);
   if(frame&&breakAt.current===null)breakAt.current=Math.max(start+CRACK_MS,performance.now());
   const draw=(now:number)=>{
    if(stopped)return;
    const elapsed=frame&&breakAt.current!==null&&now>=breakAt.current?CRACK_MS+now-breakAt.current:Math.min(CRACK_MS,Math.max(0,now-start));
    const progress=Math.max(0,Math.min(1,elapsed/SHATTER_MS)),phase=glassPhase(elapsed);
    if(progress>=1){finish();return;}
    ctx.clearRect(0,0,w,h);
    if(!frame||phase==='cracking'){
     if(frame)ctx.drawImage(frame,0,0);
     const spread=Math.min(1,Math.max(0,(now-start)/CRACK_MS));
     // Shared edges grow from the impact; the scene remains one intact pane.
     const path=new Path2D();
     for(const {a,b,order} of cracks){const t=Math.max(0,Math.min(1,(spread-order)/.2));if(!t)continue;path.moveTo(a.x*w,a.y*h);path.lineTo((a.x+(b.x-a.x)*t)*w,(a.y+(b.y-a.y)*t)*h);}
     ctx.strokeStyle='rgba(20,31,42,.34)';ctx.lineWidth=1.8;ctx.stroke(path);
     ctx.strokeStyle='rgba(228,242,249,.8)';ctx.lineWidth=.65;ctx.stroke(path);
    }else for(const {shard,index,points,path,left,top,width,height,reflection} of shards){
     const pose=shardPose(shard,progress),cx=shard.center.x*w,cy=shard.center.y*h;
     const cos=Math.cos(pose.angle),sin=Math.sin(pose.angle);
     const a=cos*pose.scaleX-sin*pose.skew,b=sin*pose.scaleX+cos*pose.skew,c=-sin*pose.scaleY,d=cos*pose.scaleY;
     const x=cx+pose.x*w,y=cy+pose.y*h;
     const projected=points.map(p=>({x:x+a*(p.x-cx)+c*(p.y-cy),y:y+b*(p.x-cx)+d*(p.y-cy)}));
     // Extrude in screen space so thickness survives even an edge-on face.
     const thickness=shard.thickness*w/1280*pose.split;
     const dx=Math.sin(pose.yaw)*thickness,dy=(.35+Math.abs(Math.sin(pose.yaw))*.65)*thickness;
     ctx.globalAlpha=pose.alpha;
     const sides=new Path2D();
     for(let i=0;i<projected.length;i++){const p=projected[i],q=projected[(i+1)%projected.length];sides.moveTo(p.x,p.y);sides.lineTo(q.x,q.y);sides.lineTo(q.x+dx,q.y+dy);sides.lineTo(p.x+dx,p.y+dy);sides.closePath();}
     ctx.fillStyle=['#a5bcb9','#b7b0c9','#c5b99f'][index%3];ctx.fill(sides);
     ctx.strokeStyle='rgba(26,39,49,.55)';ctx.lineWidth=.6;ctx.stroke(sides);
     ctx.save();ctx.transform(a,b,c,d,x-a*cx-c*cy,y-b*cx-d*cy);
     ctx.save();ctx.clip(path);ctx.drawImage(frame,left,top,width,height,left,top,width,height);
     const flash=Math.pow(Math.max(0,Math.cos(pose.yaw*3+index*.71)),8);
     ctx.globalAlpha=pose.alpha*pose.split*(.12+.65*flash);
     ctx.fillStyle=reflection;ctx.fill(path);
     ctx.restore();ctx.globalAlpha=pose.alpha;
     ctx.strokeStyle=`rgba(234,246,251,${.35+.4*flash})`;ctx.lineWidth=.75;ctx.stroke(path);ctx.restore();
    }
    ctx.globalAlpha=1;canvas.dataset.phase=frame?phase:'cracking';canvas.dataset.progress=progress.toFixed(3);raf=requestAnimationFrame(draw);
   };
   draw(performance.now()); // Cover the first title paint with the intact texture.
  }
  return()=>{stopped=true;cancelAnimationFrame(raf);clearTimeout(deadline);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',resize);reduced.removeEventListener('change',preference);canvas.width=0;canvas.height=0;};
 },[frame,seed,start]);
 return <canvas ref={canvasRef} className="glass-return-canvas" aria-hidden="true"/>;
}
