import {useLayoutEffect,useRef} from 'react';
import {glassShards,shardPose,SHATTER_MS} from '../lib/glassShatter';
import './glassReturn.css';

/** One captured pane, convex texture fragments; title is the real page below. */
export default function GlassReturn({frame,onComplete}:{frame:HTMLCanvasElement;onComplete:()=>void}){
 const canvasRef=useRef<HTMLCanvasElement>(null),complete=useRef(onComplete);complete.current=onComplete;
 useLayoutEffect(()=>{
  const canvas=canvasRef.current;if(!canvas)return;
  const ctx=canvas.getContext('2d');
  let stopped=false,raf=0;
  const finish=()=>{if(stopped)return;stopped=true;cancelAnimationFrame(raf);complete.current();};
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const visibility=()=>{if(document.hidden)finish();};
  const preference=()=>{if(reduced.matches)finish();};
  const deadline=window.setTimeout(finish,SHATTER_MS+450);
  const resize=()=>finish(); // Do not stretch a stale capture across new framing.
  document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',resize);reduced.addEventListener('change',preference);
  if(!ctx||document.hidden||reduced.matches)finish();
  else{
   canvas.width=frame.width;canvas.height=frame.height;
   const w=frame.width,h=frame.height;
   const shards=glassShards(crypto.getRandomValues(new Uint32Array(1))[0]).map(shard=>{
    const points=shard.polygon.map(p=>({x:p.x*w,y:p.y*h}));
    const path=new Path2D();path.moveTo(points[0].x,points[0].y);for(const p of points.slice(1))path.lineTo(p.x,p.y);path.closePath();
    const left=Math.max(0,Math.floor(Math.min(...points.map(p=>p.x)))-1),top=Math.max(0,Math.floor(Math.min(...points.map(p=>p.y)))-1);
    return {shard,path,left,top,width:Math.min(w-left,Math.ceil(Math.max(...points.map(p=>p.x)))-left+1),height:Math.min(h-top,Math.ceil(Math.max(...points.map(p=>p.y)))-top+1)};
   });
   canvas.dataset.shards=String(shards.length);
   // Paint before the first title frame to prevent a one-frame flash.
   ctx.drawImage(frame,0,0);
   const start=performance.now();
   const draw=(now:number)=>{
    if(stopped)return;
    const progress=Math.max(0,Math.min(1,(now-start)/SHATTER_MS));
    if(progress>=1){finish();return;}
    ctx.clearRect(0,0,w,h);
    for(const {shard,path,left,top,width,height} of shards){
     const pose=shardPose(shard,progress),cx=shard.center.x*w,cy=shard.center.y*h;
     ctx.save();ctx.translate(cx+pose.x*w,cy+pose.y*h);ctx.rotate(pose.angle);ctx.scale(pose.scaleX,pose.scaleY);ctx.translate(-cx,-cy);
     ctx.globalAlpha=pose.alpha;ctx.save();ctx.clip(path);ctx.drawImage(frame,left,top,width,height,left,top,width,height);
     // A changing glass-plane normal catches a cool edge reflection, restrained
     // against momo's warm palette; no opaque confetti layered over the scene.
     const light=Math.min(1,Math.max(0,(progress-shard.delay)*5));
     if(light>0){ctx.fillStyle=`rgba(216,233,248,${.07*light*Math.abs(Math.sin(pose.angle*3))})`;ctx.fill(path);}
     ctx.restore();ctx.strokeStyle=`rgba(224,236,247,${Math.min(.55,progress*3)*pose.alpha})`;ctx.lineWidth=.8;ctx.stroke(path);ctx.restore();
    }
    canvas.dataset.progress=progress.toFixed(3);raf=requestAnimationFrame(draw);
   };
   raf=requestAnimationFrame(draw);
  }
  return()=>{stopped=true;cancelAnimationFrame(raf);clearTimeout(deadline);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',resize);reduced.removeEventListener('change',preference);canvas.width=0;canvas.height=0;};
 },[frame]);
 return <canvas ref={canvasRef} className="glass-return-canvas" aria-hidden="true"/>;
}
