/** Stable ink cells, adapted from the website opening for a finite native entry. */
export const ENTRY_MS = 1300;
export const PRESENCE_URL = '/brand/momo-presence-v2.webp';
// Shared with Title so the first particle frame exactly follows the portrait.
export const TITLE_PRESENCE = {left:.44,top:.08,width:.62};
export const INKS = ['#e7be77', '#f3ecdf', '#615569'];
export const GLYPHS = ['0', '1', '╱', '─', '·', '╲', '+', '░'];
export type InkCell = {id:number; u:number; v:number; ink:number; seed:number; targetU:number; targetV:number};
const clamp = (value:number) => Math.max(0, Math.min(1, value));
export function ease(start:number, end:number, value:number) {
  const t = clamp((value-start)/(end-start));
  return t*t*(3-2*t);
}
const seedOf = (id:number) => ((Math.imul(id+17,0x45d9f3b)^Math.imul(id+113,0x27d4eb2d))>>>0)/4294967296;

export function inkCells({data,width,height}: Pick<ImageData,'data'|'width'|'height'>): InkCell[] {
  const palette = [[231,190,119],[243,236,223],[24,21,31]];
  const cells: InkCell[] = [];
  for (let id=0;id<width*height;id++) {
    if (data[id*4+3]<96) continue;
    const distances=palette.map(color=>color.reduce((sum,value,c)=>sum+(value-data[id*4+c])**2,0));
    cells.push({id,u:(id%width+.5)/width,v:(Math.floor(id/width)+.5)/height,
      ink:distances.indexOf(Math.min(...distances)),seed:seedOf(id),targetU:0,targetV:0});
  }
  const destinations=cells.map((_,index)=>index);
  for(let i=destinations.length-1;i>0;i--) {
    const j=Math.floor(seedOf(i)*(i+1));
    [destinations[i],destinations[j]]=[destinations[j],destinations[i]];
  }
  const rows=Math.ceil(cells.length/80);
  cells.forEach((cell,index)=>{
    cell.targetU=(destinations[index]%80+.5)/80;
    cell.targetV=(Math.floor(destinations[index]/80)+.5)/rows;
  });
  return cells;
}

/** Same cropped background placement as title.css; not the player avatar. */
export function presenceRect(width:number,height:number) {
  return {left:width*TITLE_PRESENCE.left,top:height*TITLE_PRESENCE.top,
    width:width*TITLE_PRESENCE.width,height:width*TITLE_PRESENCE.width*1.5};
}
export function inkFrame(cell:InkCell,progress:number,width:number,height:number) {
  const p=clamp(progress),source=presenceRect(width,height);
  const travel=ease(.2+cell.seed*.06,.73+cell.seed*.06,p);
  const x=source.left+cell.u*source.width,y=source.top+cell.v*source.height;
  return {x:x+(cell.targetU*width-x)*travel,
    y:y+(cell.targetV*height-y)*travel-Math.sin(travel*Math.PI)*(50+cell.seed*100),
    alpha:ease(.04+cell.v*.08,.18+cell.v*.08,p)*(1-ease(.67,.94,p)),travel};
}
