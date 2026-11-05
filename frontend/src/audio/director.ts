import {ambient,type Music} from './ambient';
export type Mood='neutral'|'bright'|'quiet'|'comfort';
const tracks:Music[]=['title','connection','daily','night','uplift','comfort'];
const moods=new Set<Mood>(['neutral','bright','quiet','comfort']);
/** Only confirmed visible local dialogue cues enter here, never raw user/QQ text. */
export class MusicDirector {
 private manual=false;private commandTurn='';
 private route='title';private intro=false;private current:Music='title';private changed=0;
 private candidate:Mood|null=null;private count=0;private turn='';
 constructor(private choose:(id:Music)=>void,private now=()=>performance.now(),private hour=()=>new Date().getHours()){}
 private normal():Music{return this.hour()>=22||this.hour()<6?'night':'daily';}
 private select(id:Music){if(this.current!==id){this.current=id;this.changed=this.now();this.choose(id);}}
 page(route:string,intro:boolean){
  const entering=route==='chat'&&this.route==='title';this.route=route;this.intro=intro;
  if(route==='title'){this.manual=false;this.commandTurn='';this.candidate=null;this.count=0;this.turn='';this.select(intro?'connection':'title');}
  else if(route==='chat'){if(intro)this.select('connection');else if(!this.manual&&(entering||this.current==='connection'||this.current==='title'))this.select(this.normal());}
 }
 command(value:unknown,turn:string){
  if(this.route!=='chat'||this.intro||turn===this.commandTurn||typeof value!=='string')return;
  if(value!=='next'&&value!=='auto'&&!tracks.includes(value as Music))return;
  this.commandTurn=turn;this.turn=turn;this.candidate=null;this.count=0;
  this.manual=value!=='auto';
  const target=value==='auto'?this.normal():value==='next'?tracks[(tracks.indexOf(this.current)+1)%tracks.length]:value as Music;
  this.select(target);
 }
 cue(value:unknown,turn:string){
  if(this.manual||this.route!=='chat'||this.intro||!moods.has(value as Mood)||turn===this.turn)return;
  this.turn=turn;const mood=value as Mood;
  this.count=this.candidate===mood?this.count+1:1;this.candidate=mood;
  // Serious comfort is an explicit low-intensity escape from a bright cue.
  if(mood==='comfort'){this.select('comfort');return;}
  if(this.count<2||this.now()-this.changed<60_000)return;
  this.select(mood==='bright'?'uplift':mood==='quiet'?'night':this.normal());
 }
}
export const musicDirector=new MusicDirector(id=>ambient.scene(id));
