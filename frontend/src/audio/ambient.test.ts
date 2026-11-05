import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {AmbientAudio} from './ambient';
const sources:{buffer:unknown;loop:boolean;start:ReturnType<typeof vi.fn>;stop:ReturnType<typeof vi.fn>;connect:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>;onended?:()=>void}[]=[];
const gains:{gain:{value:number;setTargetAtTime:ReturnType<typeof vi.fn>;cancelScheduledValues:ReturnType<typeof vi.fn>;linearRampToValueAtTime:ReturnType<typeof vi.fn>;setValueAtTime:ReturnType<typeof vi.fn>};connect:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}[]=[];
const tick=()=>new Promise(r=>setTimeout(r,0));
beforeEach(()=>{
 sources.length=0;gains.length=0;
 vi.stubGlobal('document',{hidden:false,hasFocus:()=>true});vi.stubGlobal('navigator',{});
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)})));
 vi.stubGlobal('AudioContext',class {
  state='running';currentTime=0;destination={};
  resume=vi.fn(async()=>{this.state='running';});suspend=vi.fn(async()=>{this.state='suspended';});
  decodeAudioData=vi.fn(async()=>({duration:48}));
  createGain(){const node={gain:{value:0,setTargetAtTime:vi.fn(),cancelScheduledValues:vi.fn(),linearRampToValueAtTime:vi.fn(),setValueAtTime:vi.fn()},connect:vi.fn(),disconnect:vi.fn()};gains.push(node);return node;}
  createBufferSource(){const node={buffer:null,loop:false,start:vi.fn(),stop:vi.fn(),connect:vi.fn(),disconnect:vi.fn()};sources.push(node);return node;}
 });
});
afterEach(()=>vi.unstubAllGlobals());
describe('ambient audio',()=>{
 it('does not queue pre-gesture sound and starts only one loop',async()=>{
  const a=new AmbientAudio();a.sound('confirm');expect(sources).toHaveLength(0);await a.unlock();await tick();
  expect(sources.filter(s=>s.loop)).toHaveLength(1);a.scene('title');a.configure({musicVolume:22});await tick();expect(sources.filter(s=>s.loop)).toHaveLength(1);
 });
 it('drops repeated effects and respects recording and mute',async()=>{
  const a=new AmbientAudio();await a.unlock();await tick();a.sound('confirm');a.sound('confirm');expect(sources.filter(s=>!s.loop)).toHaveLength(1);
  const mic={};a.microphone(mic,true);a.sound('on');expect(sources.filter(s=>!s.loop)).toHaveLength(1);expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0,0,.18/3);
  a.configure({musicVolume:0,sfxVolume:0});a.microphone(mic,false);a.sound('off');expect(sources.filter(s=>!s.loop)).toHaveLength(1);expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0,0,.18/3);
 });
 it('ducks only when a playback source reports audible sound',async()=>{
  const a=new AmbientAudio();await a.unlock();await tick();const voice={};a.speech(voice,true);expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(.22*.25,0,.18/3);
  a.speech(voice,false);expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(.22,0,.18/3);
 });
 it('keeps previous music when next audio fails',async()=>{
  const a=new AmbientAudio();await a.unlock();await tick();vi.mocked(fetch).mockRejectedValue(new Error('offline'));a.scene('daily');await tick();expect(sources.filter(s=>s.loop)).toHaveLength(1);expect(sources[0].stop).not.toHaveBeenCalled();
 });
 it('discards stale scene loading after mute',async()=>{
  const a=new AmbientAudio();await a.unlock();await tick();let finish!:(r:Response)=>void;vi.mocked(fetch).mockImplementation(()=>new Promise(r=>{finish=r;}));a.scene('daily');a.configure({musicVolume:0});finish({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)} as Response);await tick();expect(sources.filter(s=>s.loop)).toHaveLength(1);expect(sources[0].stop).toHaveBeenCalled();
 });
});
it('releases the cross-tab lock when focus is lost while resume is pending',async()=>{
 const events=new Map<string,()=>void>();let focused=true;const resumes:(()=>void)[]=[];let lockDone=false;
 const documentMock={hidden:false,hasFocus:()=>focused,addEventListener:vi.fn(),removeEventListener:vi.fn()};vi.stubGlobal('document',documentMock);
 vi.stubGlobal('window',{addEventListener:(key:string,fn:()=>void)=>events.set(key,fn),removeEventListener:vi.fn()});
 const Base=AudioContext;
 vi.stubGlobal('AudioContext',class extends Base {override resume=()=>new Promise<void>(resolve=>{resumes.push(resolve);});});
 vi.stubGlobal('navigator',{locks:{request:(_name:string,_opts:unknown,callback:(lock:object)=>Promise<void>)=>callback({}).then(()=>{lockDone=true;})}});
 const a=new AmbientAudio();const dispose=a.install();const unlocking=a.unlock();await tick();focused=false;events.get('blur')!();resumes.forEach(resolve=>resolve());await unlocking;await tick();expect(lockDone).toBe(true);expect(sources).toHaveLength(0);dispose();
});
