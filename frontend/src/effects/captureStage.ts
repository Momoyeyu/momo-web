import {captureFonts} from './captureFonts';
import {getStage} from '../live2d/stage';
import {PRESENCE_URL} from '../lib/presenceTransition';

/** A transient local texture, never persisted, uploaded or kept after navigation.
 * Lazy-loaded by hover/focus; the renderer only exists for the transition. */
export const prepareCapture=()=>import('html-to-image');
let titleAssets:Promise<void>|undefined;
export function prepareTitle(){
  titleAssets??=Promise.allSettled([PRESENCE_URL,'/brand/momo-mark.svg','/brand/momo-wordmark.svg'].map(src=>{
    const image=new Image();image.src=src;return image.decode();
  })).then(()=>{});
  return titleAssets;
}
export function warmCapture(node:HTMLElement){
  void prepareTitle();
  void prepareCapture().catch(()=>{});
  return captureFonts(node).catch(()=> '');
}
export async function captureStage(node:HTMLElement):Promise<HTMLCanvasElement|null>{
  let expired=false,timer=0;
  const start=performance.now();
  const work=Promise.all([prepareCapture(),warmCapture(node)]).then(([{toCanvas},fontEmbedCSS])=>{
    if(expired)return null;
    const {width,height}=node.getBoundingClientRect();
    return toCanvas(node,{width,height,pixelRatio:Math.min(1,1280/width),preferredFontFormat:'woff2',
      fontEmbedCSS, skipFonts: !fontEmbedCSS,
      style:{position:'relative',inset:'0',margin:'0'},
      filter:element=>{
        if(element instanceof Element){
          if(element.matches('.tooltip-layer,.chat-entry-canvas,.glass-return-canvas,.tx-fx'))return false;
          const css=getComputedStyle(element);
          if(css.display==='none')return false;
          // The room retains all four photographs for its time-of-day fade.
          // Transparent, out-of-flow layers contribute no pixels or layout.
          if(css.opacity==='0' && (css.position==='absolute'||css.position==='fixed'))return false;
        }
        // WebGL discards its buffer between paints. Repaint in the same task
        // immediately before html-to-image serializes this particular canvas.
        if(element instanceof HTMLCanvasElement && element.classList.contains('live2d-canvas'))getStage().renderForSnapshot();
        return true;
      },
    });
  }).then(canvas=>{if(expired&&canvas){canvas.width=0;canvas.height=0;return null;}return canvas;}).catch(()=>{performance.mark('momo-home-capture-failed');return null;});
  const deadline=new Promise<null>(resolve=>{timer=window.setTimeout(()=>{expired=true;performance.mark('momo-home-capture-timeout');resolve(null);},1400);});
  const result=await Promise.race([work,deadline]);clearTimeout(timer);performance.measure('momo-home-capture',{start,end:performance.now()});return result;
}
