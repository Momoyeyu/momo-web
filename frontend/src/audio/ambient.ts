/** Environmental audio persists across routes. No inference or synthesis at runtime. */
export type Sound = 'tap'|'confirm'|'cancel'|'on'|'off'|'phone-in'|'phone-out'|'boot'|'home'|'complete'|'notify';
export type Music = 'title'|'connection'|'daily'|'night'|'uplift'|'comfort';
const tempo:Record<Music,number>={title:76,connection:76,daily:84,night:64,uplift:96,comfort:68};
type Config = {sfxVolume?:number;musicVolume?:number;soundPalette?:'warm'|'glass'};
export class AmbientAudio {
 private ctx:AudioContext|null=null;
 private musicBus:GainNode|null=null;
 private sfxBus:GainNode|null=null;
 private cache=new Map<string,AudioBuffer>();
 private loads=new Map<string,Promise<AudioBuffer>>();
 private loadRequests=new Map<string,AbortController>();
 private effects=new Set<AudioBufferSourceNode>();
 private cooldown=new Map<string,number>();
 private lastSound=-Infinity;
 private voices=new Set<object>();
 private voiceRelease=new Map<object,ReturnType<typeof setTimeout>>();
 private musicSources=new Set<AudioBufferSourceNode>();
 private mics=new Set<object>();
 private config:Config={};
 private desired:Music='title';
 private music:{id:Music;source:AudioBufferSourceNode;gain:GainNode;started:number}|null=null;
 private revision=0;
 private owned=false;
 private lockPending=false;
 private release:(()=>void)|null=null;
 configure(config:Config){this.config=config;this.mix();if((config.musicVolume??22)===0){this.revision++;this.stopMusic();}else void this.syncMusic();}
 private level(value:number|undefined,fallback:number){return Math.min(100,Math.max(0,Number.isFinite(value)?value!:fallback))/100;}
 private ramp(node:GainNode|null,value:number,time=.18){if(!node||!this.ctx)return;node.gain.cancelScheduledValues(this.ctx.currentTime);node.gain.setTargetAtTime(value,this.ctx.currentTime,time/3);}
 private mix(){const mic=this.mics.size>0;const voice=this.voices.size>0;this.ramp(this.sfxBus,mic?0:this.level(this.config.sfxVolume,35)*(voice?.4:1));this.ramp(this.musicBus,mic?0:this.level(this.config.musicVolume,22)*(voice?.25:1));}
 speech(key:object,active:boolean){
  if(active){clearTimeout(this.voiceRelease.get(key));this.voiceRelease.delete(key);this.voices.add(key);this.mix();}
  else if(this.voices.has(key)&&!this.voiceRelease.has(key))this.voiceRelease.set(key,setTimeout(()=>{this.voiceRelease.delete(key);this.voices.delete(key);this.mix();},350));
 }
 microphone(key:object,active:boolean){if(active)this.mics.add(key);else this.mics.delete(key);this.mix();}
 scene(id:Music){if(this.desired===id)return;this.desired=id;this.revision++;for(const [name,request] of this.loadRequests)if(name in tempo&&name!==id)request.abort();void this.syncMusic();}
 private async load(name:string){
  const ready=this.cache.get(name);if(ready)return ready;
  const old=this.loads.get(name);if(old&&!this.loadRequests.get(name)?.signal.aborted)return old;
  const ctx=this.ctx;if(!ctx)throw Error('locked');
  const request=new AbortController();this.loadRequests.set(name,request);const timeout=setTimeout(()=>request.abort(),15000);
  const job=(async()=>{const response=await fetch(`/audio/${name}.wav`,{signal:request.signal});if(!response.ok)throw Error('audio unavailable');const buffer=await ctx.decodeAudioData(await response.arrayBuffer());request.signal.throwIfAborted();this.cache.set(name,buffer);
  const musicKeys=[...this.cache.keys()].filter(k=>k in tempo);
  while(musicKeys.length>2){const victim=musicKeys.find(k=>k!==name&&k!==this.music?.id)??musicKeys[0];this.cache.delete(victim);musicKeys.splice(musicKeys.indexOf(victim),1);}
  while(this.cache.size>15)this.cache.delete(this.cache.keys().next().value!);return buffer;})();
  this.loads.set(name,job);try{return await job;}finally{clearTimeout(timeout);if(this.loadRequests.get(name)===request)this.loadRequests.delete(name);if(this.loads.get(name)===job)this.loads.delete(name);}
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
   for(const id of ['tap','confirm','cancel','on','off','phone-in','phone-out','boot','home','complete','notify'])void this.load(`${this.config.soundPalette??'warm'}-${id}`).catch(()=>{});
  }catch{/* Autoplay denial never blocks interaction. */}
 }
 sound(id:Sound){
  const ctx=this.ctx;const now=performance.now();if(!ctx||ctx.state!=='running'||!this.owned||this.mics.size||!this.level(this.config.sfxVolume,35)||this.effects.size>=4||now-(this.cooldown.get(id)??-Infinity)<90)return;
  if(id==='tap'&&now-this.lastSound<50)return;
  const name=`${this.config.soundPalette??'warm'}-${id}`;const buffer=this.cache.get(name);
  if(!buffer){void this.load(name).catch(()=>{});return;}
  this.cooldown.set(id,now);this.lastSound=now;const source=ctx.createBufferSource();source.buffer=buffer;source.connect(this.sfxBus!);this.effects.add(source);source.onended=()=>{source.disconnect();this.effects.delete(source);};source.start();
 }
 private async syncMusic(){
  const ctx=this.ctx;if(!ctx||ctx.state!=='running'||!this.owned||!this.level(this.config.musicVolume,22)||this.music?.id===this.desired)return;
  const revision=this.revision;const id=this.desired;
  try{const buffer=await this.load(id);if(revision!==this.revision||!this.owned||ctx.state!=='running'||!this.level(this.config.musicVolume,22)||this.music?.id===id)return;
   const source=ctx.createBufferSource();source.buffer=buffer;source.loop=true;source.loopStart=0;source.loopEnd=buffer.duration;
   const gain=ctx.createGain();gain.gain.value=0;source.connect(gain);gain.connect(this.musicBus!);
   const previous=this.music;
   const bar=previous?240/tempo[previous.id]:0;
   const untilBar=previous?(bar-((ctx.currentTime-previous.started)%bar))%bar:0;
   // Align compatible tempos within one second; cross-tempo cues use a bounded fade.
   const at=ctx.currentTime+(previous&&tempo[previous.id]===tempo[id]&&untilBar<1?untilBar:0);
   for(const old of this.musicSources)if(old!==previous?.source){old.stop();this.musicSources.delete(old);}
   this.musicSources.add(source);this.music={id,source,gain,started:at};source.start(at);gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(1,at+1.2);
   if(previous){previous.gain.gain.cancelScheduledValues(ctx.currentTime);previous.gain.gain.setValueAtTime(previous.gain.gain.value,ctx.currentTime);previous.gain.gain.linearRampToValueAtTime(0,at+1.2);previous.source.stop(at+1.25);}
   source.onended=()=>{this.musicSources.delete(source);source.disconnect();gain.disconnect();};
  }catch{/* Keep the previous track on load failure. */}
 }
 private stopMusic(){for(const source of this.musicSources)source.stop();this.musicSources.clear();this.music=null;}
 private hide=()=>{if(!document.hidden&&document.hasFocus()){if(this.ctx)void this.unlock();return;}this.revision++;for(const s of this.effects)s.stop();this.effects.clear();void this.ctx?.suspend();this.release?.();this.release=null;this.owned=false;};
 install(){const gesture=()=>void this.unlock();document.addEventListener('pointerdown',gesture,{capture:true});document.addEventListener('keydown',gesture,{capture:true});document.addEventListener('visibilitychange',this.hide);window.addEventListener('blur',this.hide);window.addEventListener('focus',this.hide);return()=>{document.removeEventListener('pointerdown',gesture,true);document.removeEventListener('keydown',gesture,true);document.removeEventListener('visibilitychange',this.hide);window.removeEventListener('blur',this.hide);window.removeEventListener('focus',this.hide);this.release?.();this.release=null;this.owned=false;this.revision++;void this.ctx?.suspend();};}
}
export const ambient=new AmbientAudio();
