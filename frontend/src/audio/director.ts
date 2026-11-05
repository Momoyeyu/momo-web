import {ambient,type Music} from './ambient';
export type Mood='neutral'|'bright'|'quiet'|'comfort';
const moods=new Set<Mood>(['neutral','bright','quiet','comfort']);
/** Only confirmed visible local dialogue cues enter here, never raw user/QQ text. */
export class MusicDirector {
 private route='title';private intro=false;private current:Music='title';private changed=0;
 private candidate:Mood|null=null;private count=0;private turn='';
 constructor(private choose:(id:Music)=>void,private now=()=>performance.now(),private hour=()=>new Date().getHours()){}
 private normal():Music{return this.hour()>=22||this.hour()<6?'night':'daily';}
 private select(id:Music){if(this.current!==id){this.current=id;this.changed=this.now();this.choose(id);}}
 page(route:string,intro:boolean){
  const entering=route==='chat'&&this.route==='title';this.route=route;this.intro=intro;
  if(route==='title'){this.candidate=null;this.count=0;this.turn='';this.select(intro?'connection':'title');}
  else if(route==='chat'){if(intro)this.select('connection');else if(entering||this.current==='connection'||this.current==='title')this.select(this.normal());}
 }
 cue(value:unknown,turn:string){
  if(this.route!=='chat'||this.intro||!moods.has(value as Mood)||turn===this.turn)return;
  this.turn=turn;const mood=value as Mood;
  this.count=this.candidate===mood?this.count+1:1;this.candidate=mood;
  // Serious comfort is an explicit low-intensity escape from a bright cue.
  if(mood==='comfort'){this.select('comfort');return;}
  if(this.count<2||this.now()-this.changed<60_000)return;
  this.select(mood==='bright'?'uplift':mood==='quiet'?'night':this.normal());
 }
}
export const musicDirector=new MusicDirector(id=>ambient.scene(id));
