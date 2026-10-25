import {useEffect,useRef} from 'react';
import {ENTRY_MS,PRESENCE_URL,INKS,GLYPHS,ease,inkCells,inkFrame,presenceRect} from '../lib/presenceTransition';
import '../styles/presence-entry.css';

/** Only the decoration owns a clock; the real room and avatar stay underneath. */
export default function ChatEntryTransition({onComplete}:{onComplete:()=>void}) {
  const ref=useRef<HTMLCanvasElement>(null);
  const complete=useRef(onComplete);
  complete.current=onComplete;
  useEffect(()=>{
    const canvas=ref.current;
    if(!canvas) return;
    const context=canvas.getContext('2d');
    let stopped=false,raf=0,observer:ResizeObserver|undefined;
    const finish=()=>{if(stopped)return;stopped=true;cancelAnimationFrame(raf);complete.current();};
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    const visibility=()=>{if(document.hidden)finish();};
    const preference=()=>{if(reduced.matches)finish();};
    // A missing image, throttled RAF or hidden window must never trap the game.
    const deadline=window.setTimeout(finish,1800);
    document.addEventListener('visibilitychange',visibility);
    reduced.addEventListener('change',preference);
    if(!context||document.hidden||reduced.matches)finish();
    else {
      const figure=new Image();figure.src=PRESENCE_URL;
      void figure.decode().then(()=>{
        if(stopped)return;
        const sample=document.createElement('canvas');sample.width=80;sample.height=120;
        const sampling=sample.getContext('2d',{willReadFrequently:true});
        if(!sampling){finish();return;}
        sampling.drawImage(figure,0,0,80,120);
        const cells=inkCells(sampling.getImageData(0,0,80,120));
        if(!cells.length){finish();return;}
        // Rasterize the small glyph alphabet once, not thousands of fonts per frame.
        const atlas=document.createElement('canvas');atlas.width=GLYPHS.length*14;atlas.height=INKS.length*18;
        const letters=atlas.getContext('2d');
        if(!letters){finish();return;}
        letters.font='12px monospace';letters.textAlign='center';letters.textBaseline='middle';
        INKS.forEach((ink,row)=>{letters.fillStyle=ink;GLYPHS.forEach((glyph,col)=>letters.fillText(glyph,col*14+7,row*18+9));});
        const background=getComputedStyle(canvas).getPropertyValue('--bg').trim()||'#18151f';
        let width=0,height=0,ratio=1;
        const resize=()=>{
          if(stopped)return;
          const box=canvas.getBoundingClientRect();width=box.width;height=box.height;
          ratio=Math.min(devicePixelRatio||1,1.5);
          canvas.width=Math.max(1,Math.round(width*ratio));canvas.height=Math.max(1,Math.round(height*ratio));
        };
        resize();
        observer=new ResizeObserver(resize);observer.observe(canvas);
        const start=performance.now();
        const draw=(now:number)=>{
          if(stopped)return;
          if(now-start>=ENTRY_MS){finish();return;}
          const p=Math.max(0,Math.min(1,(now-start)/ENTRY_MS));
          context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
          context.globalAlpha=1-ease(.85,1,p);context.fillStyle=background;context.fillRect(0,0,width,height);
          context.globalAlpha=1;
          // A diagonal print front opens holes onto the actual live room.
          const columns=64,rows=36,bw=width/columns,bh=height/rows;
          if(p>.34)for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
            const order=(col/columns)*.58+(row/rows)*.42;
            const reveal=ease(.34+order*.36,.46+order*.36,p);
            if(reveal)context.clearRect(col*bw,row*bh,bw*reveal+1/ratio,bh*reveal+1/ratio);
          }
          const source=presenceRect(width,height);
          context.globalAlpha=.2*(1-ease(.07,.3,p));
          if(context.globalAlpha>0)context.drawImage(figure,source.left,source.top,source.width,source.height);
          for(const cell of cells){
            const frame=inkFrame(cell,p,width,height);
            if(frame.alpha<.01||frame.x<-20||frame.x>width+20||frame.y<-20||frame.y>height+20)continue;
            context.globalAlpha=frame.alpha*(cell.ink===2?.2:.55);
            context.drawImage(atlas,(cell.id%GLYPHS.length)*14,cell.ink*18,14,18,frame.x-4,frame.y-5,8,10);
          }
          context.globalAlpha=1;
          canvas.dataset.phase=p<.16?'ink':p<.62?'glyphs':'room';
          canvas.dataset.progress=p.toFixed(3);canvas.dataset.cells=String(cells.length);
          raf=requestAnimationFrame(draw);
        };
        raf=requestAnimationFrame(draw);
      }).catch(finish);
    }
    return ()=>{
      stopped=true;cancelAnimationFrame(raf);clearTimeout(deadline);
      observer?.disconnect();
      document.removeEventListener('visibilitychange',visibility);
      reduced.removeEventListener('change',preference);
      canvas.width=0;canvas.height=0;
    };
  },[]);
  return <canvas ref={ref} className="chat-entry-canvas" aria-hidden="true" />;
}
