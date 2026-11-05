/** Environmental audio persists across routes. No inference or synthesis at runtime. */
export type Sound = 'confirm'|'cancel'|'on'|'off'|'phone-in'|'phone-out'|'boot'|'home'|'complete'|'notify';
export type Music = 'title'|'daily';
type Config = {sfxVolume?:number;musicVolume?:number;soundPalette?:'warm'|'glass'};
export class AmbientAudio {
 private ctx:AudioContext|null=null;
 private musicBus:GainNode|null=null;
 private sfxBus:GainNode|null=null;
 private cache=new Map<string,AudioBuffer>();
 private loads=new Map<string,Promise<AudioBuffer>>();
 private effects=new Set<AudioBufferSourceNode>();
 private cooldown=new Map<string,number>();
 private voices=new Set<object>();
 private mics=new Set<object>();
 private config:Config={};
 private desired:Music='title';
 private music:{id:Music;source:AudioBufferSourceNode;gain:GainNode}|null=null;
 private revision=0;
 private owned=false;
 private lockPending=false;
 private release:(()=>void)|null=null;
 configure(config:Config){this.config=config;this.mix();if((config.musicVolume??22)===0){this.revision++;this.stopMusic();}else void this.syncMusic();}
 private level(value:number|undefined,fallback:number){return Math.min(100,Math.max(0,Number.isFinite(value)?value!:fallback))/100;}
 private ramp(node:GainNode|null,value:number,time=.18){if(!node||!this.ctx)return;node.gain.cancelScheduledValues(this.ctx.currentTime);node.gain.setTargetAtTime(value,this.ctx.currentTime,time/3);}
 private mix(){const mic=this.mics.size>0;const voice=this.voices.size>0;this.ramp(this.sfxBus,mic?0:this.level(this.config.sfxVolume,35)*(voice?.4:1));this.ramp(this.musicBus,mic?0:this.level(this.config.musicVolume,22)*(voice?.25:1));}
 speech(key:object,active:boolean){if(active)this.voices.add(key);else this.voices.delete(key);this.mix();}
 microphone(key:object,active:boolean){if(active)this.mics.add(key);else this.mics.delete(key);this.mix();}
 scene(id:Music){if(this.desired===id)return;this.desired=id;this.revision++;void this.syncMusic();}
 private async load(name:string){
  const ready=this.cache.get(name);if(ready)return ready;
  const old=this.loads.get(name);if(old)return old;
  const ctx=this.ctx;if(!ctx)throw Error('locked');
  const job=(async()=>{const response=await fetch(`/audio/${name}.wav`);if(!response.ok)throw Error('audio unavailable');const buffer=await ctx.decodeAudioData(await response.arrayBuffer());this.cache.set(name,buffer);while(this.cache.size>14)this.cache.delete(this.cache.keys().next().value!);return buffer;})();
  this.loads.set(name,job);try{return await job;}finally{this.loads.delete(name);}
 }
 async unlock(){
  try{
   if(!this.ctx){this.ctx=new AudioContext();this.musicBus=this.ctx.createGain();this.sfxBus=this.ctx.createGain();this.musicBus.connect(this.ctx.destination);this.sfxBus.connect(this.ctx.destination);this.mix();}
   if(document.hidden||!document.hasFocus())return;
   if(!this.owned&&!this.lockPending){
    if(navigator.locks){this.lockPending=true;void navigator.locks.request('momo-environment-audio',{ifAvailable:true},async lock=>{this.lockPending=false;if(!lock||document.hidden||!document.hasFocus())return;this.owned=true;const held=new Promise<void>(resolve=>{this.release=resolve;});try{await this.ctx?.resume();if(!this.owned||document.hidden||!document.hasFocus()){this.release?.();await this.ctx?.suspend();}else void this.syncMusic();await held;}finally{this.owned=false;this.release=null;}}).catch(()=>{this.lockPending=false;});}
    else this.owned=true;
   }
   if(this.owned){await this.ctx.resume();void this.syncMusic();}
   // Preload only common UI sounds. A missing sound is skipped, never queued.
   for(const id of ['confirm','cancel','on','off','phone-in','phone-out','boot','home','complete','notify'])void this.load(`${this.config.soundPalette??'warm'}-${id}`).catch(()=>{});
  }catch{/* Autoplay denial never blocks interaction. */}
 }
 sound(id:Sound){
  const ctx=this.ctx;const now=performance.now();if(!ctx||ctx.state!=='running'||!this.owned||this.mics.size||!this.level(this.config.sfxVolume,35)||this.effects.size>=4||now-(this.cooldown.get(id)??-Infinity)<90)return;
  const name=`${this.config.soundPalette??'warm'}-${id}`;const buffer=this.cache.get(name);
  if(!buffer){void this.load(name).catch(()=>{});return;}
  this.cooldown.set(id,now);const source=ctx.createBufferSource();source.buffer=buffer;source.connect(this.sfxBus!);this.effects.add(source);source.onended=()=>{source.disconnect();this.effects.delete(source);};source.start();
 }
 private async syncMusic(){
  const ctx=this.ctx;if(!ctx||ctx.state!=='running'||!this.owned||!this.level(this.config.musicVolume,22)||this.music?.id===this.desired)return;
  const revision=this.revision;const id=this.desired;
  try{const buffer=await this.load(id);if(revision!==this.revision||!this.owned||ctx.state!=='running'||!this.level(this.config.musicVolume,22)||this.music?.id===id)return;
   const source=ctx.createBufferSource();source.buffer=buffer;source.loop=true;source.loopStart=0;source.loopEnd=buffer.duration;
   const gain=ctx.createGain();gain.gain.value=0;source.connect(gain);gain.connect(this.musicBus!);
   const previous=this.music;this.music={id,source,gain};source.start();gain.gain.linearRampToValueAtTime(1,ctx.currentTime+1.2);
   if(previous){previous.gain.gain.cancelScheduledValues(ctx.currentTime);previous.gain.gain.setValueAtTime(previous.gain.gain.value,ctx.currentTime);previous.gain.gain.linearRampToValueAtTime(0,ctx.currentTime+1.2);previous.source.stop(ctx.currentTime+1.25);}
   source.onended=()=>{source.disconnect();gain.disconnect();};
  }catch{/* Keep the previous track on load failure. */}
 }
 private stopMusic(){if(this.music){this.music.source.stop();this.music=null;}}
 private hide=()=>{if(!document.hidden&&document.hasFocus()){if(this.ctx)void this.unlock();return;}this.revision++;for(const s of this.effects)s.stop();this.effects.clear();void this.ctx?.suspend();this.release?.();this.release=null;this.owned=false;};
 install(){const gesture=()=>void this.unlock();document.addEventListener('pointerdown',gesture,{capture:true});document.addEventListener('keydown',gesture,{capture:true});document.addEventListener('visibilitychange',this.hide);window.addEventListener('blur',this.hide);window.addEventListener('focus',this.hide);return()=>{document.removeEventListener('pointerdown',gesture,true);document.removeEventListener('keydown',gesture,true);document.removeEventListener('visibilitychange',this.hide);window.removeEventListener('blur',this.hide);window.removeEventListener('focus',this.hide);this.release?.();this.release=null;this.owned=false;this.revision++;void this.ctx?.suspend();};}
}
export const ambient=new AmbientAudio();
