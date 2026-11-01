/** Shared print-front window: a cell opens as a square, rather than fading pixels. */
export function gridReveal(order:number,progress:number,start=0,stagger=.65,span=.35){
 const t=Math.max(0,Math.min(1,(progress-start-order*stagger)/span));return t*t*(3-2*t);
}
/** One field reversed: bottom-up appearance becomes top-down disappearance. */
export function phoneGridReveal(row:number,rows:number,progress:number){
 return gridReveal((rows-1-row)/Math.max(1,rows-1),progress);
}
