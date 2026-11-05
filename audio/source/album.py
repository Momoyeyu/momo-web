"""momo / Phase & Presence — original loop scores and independently arranged OST.
Python + numpy; ffmpeg is an offline export tool, never a player dependency.
Run backend/.venv/bin/python audio/source/album.py
"""
from pathlib import Path
import json, math, struct, wave, subprocess, hashlib, zipfile, runpy
import numpy as np
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'frontend/public/audio'
RELEASE=ROOT/'.workbuddy/audio-release'; RELEASE.mkdir(parents=True,exist_ok=True)
# Preserve the approved two SFX palettes, also reproducibly builds audition reels.
runpy.run_path(str(Path(__file__).with_name('render.py')))
SPECS=[
 ('title','待机心跳','Standby Heart',76,'D major',[50,47,43,45],1.0),
 ('connection','初次连接','First Connection',76,'D major',[50,54,43,45],.83),
 ('daily','同频日常','In Phase',84,'D major',[50,54,43,45],.9),
 ('night','夜间微光','Afterglow',64,'B minor',[47,43,50,45],.55),
 ('uplift','小小跃迁','Quantum Hop',96,'D major',[50,55,52,45],1.05),
 ('comfort','留在这里','Stay Here',68,'D major',[43,47,52,50],.6),
]
CHORDS={50:[50,57,61,66],47:[47,54,59,62],43:[43,50,57,62],45:[45,52,57,61],54:[54,57,61,69],55:[43,55,59,66],52:[40,52,55,62]}
PARTS=['keys','bass','air','spark']

def score(spec,ost):
 name,_,_,bpm,key,roots,energy=spec
 # OST has a new intro, development bridge, expanded return and tonic coda.
 sections=[('intro',4),('theme',8),('answer',8),('bridge',8),('return',12),('coda',8)] if ost else [('theme',8),('answer',8),('breath',8),('return',8)]
 events=[];form=[];bar=0
 def add(part,n,beat,duration,velocity,pan=0):
  assert 0<=n<=127 and duration>0 and beat>=0
  events.append(dict(part=part,note=n,beat=beat,duration=duration,velocity=velocity,pan=pan))
 for section,count in sections:
  form.append(dict(section=section,startBar=bar,bars=count))
  for j in range(count):
   base=bar*4;root=roots[(j//2)%4];chord=CHORDS[root]
   if section=='bridge':chord=CHORDS[[52,47,43,45][(j//2)%4]]
   if section=='coda' and j>=count-2:chord=CHORDS[50 if name!='night' else 47]
   density=.55 if section in ('intro','breath','coda') else 1
   fade=(count-j)/count if section=='coda' else 1
   for n in chord[1:]:add('air',n,base,5.5,.045*energy*fade,(-.45 if n%2 else .45))
   add('bass',chord[0]-12,base,2.8,.15*energy*fade)
   if name in ('title','uplift') and section not in ('intro','coda'):add('bass',chord[0]-12,base+.75,1.1,.065*energy)
   # Identity first; rhythmic augmentation at night, fragmentation in the bridge.
   motif=[74,69,76,78] if j%4<2 else [76,73,71,69]
   if section in ('answer','return'):motif=[78,76,81,74] if j%4<2 else [76,74,73,74]
   if section=='bridge':motif=[76,71,73,78] if j%2==0 else [74,73,71,69]
   if name=='night':motif=[n-12 for n in motif]
   if name=='comfort':motif=[74,73,69,66] if j%2==0 else [67,69,73,74]
   if section=='coda':motif=[74,69,66,62] if name!='night' else [71,66,62,59]
   rhythm=[0,.75,1.75,3] if name=='uplift' else [0,1,2.5,3.25]
   indices=[0,2] if density<1 or name in ('night','comfort') else range(4)
   if section=='intro' and j<2:indices=[0]
   if section=='coda' and j>=count-2:indices=[0]
   for k in indices:add('keys',motif[k],base+rhythm[k],2.8 if density<1 else 1.8,(.135 if k==0 else .092)*energy*fade,(-.12 if k%2 else .12))
   if section in ('answer','return') and name not in ('night','comfort'):
    for k,n in enumerate(chord[1:]):add('spark',n+12,base+.5+k,1.35,.045*energy,(-.35 if k%2 else .35))
   if section=='bridge' and j%2==1:add('spark',chord[2]+12,base+2,2,.05,.3)
   bar+=1
 return dict(id=name,bpm=bpm,key=key,bars=bar,beatsPerBar=4,sections=form,events=events)

def instrument(note,duration,part,sr):
 t=np.arange(round(duration*sr),dtype=np.float64)/sr;f=440*2**((note-69)/12)
 attack={'keys':.008,'bass':.018,'air':.45,'spark':.006}[part]
 release={'keys':.15,'bass':.18,'air':.7,'spark':.18}[part]
 env=np.minimum(1,t/attack)*np.minimum(1,(duration-t)/release)
 if part=='air':x=np.sin(2*np.pi*f*t)+.13*np.sin(2*np.pi*f*2*t);env*=.6+.4*np.exp(-t/.9)
 elif part=='bass':x=np.sin(2*np.pi*f*t)+.18*np.sin(2*np.pi*f*2*t);env*=np.exp(-t/1.1)
 else:
  x=np.sin(2*np.pi*f*t+.32*np.sin(2*np.pi*f*2*t)*np.exp(-t*4))+.16*np.sin(2*np.pi*f*3*t)*np.exp(-t*4)
  env*=np.exp(-t/(.85 if part=='keys' else .35))
 return (x*env).astype(np.float32)

def render(s,sr,loop):
 beat=60/s['bpm'];frames=round(s['bars']*4*beat*sr)+(0 if loop else sr*4)
 stems={part:np.zeros((frames,2),dtype=np.float32) for part in PARTS}
 for e in s['events']:
  v=instrument(e['note'],e['duration']*beat,e['part'],sr)*e['velocity'];start=round(e['beat']*beat*sr)
  for c,pan in enumerate([math.sqrt((1-e['pan'])/2),math.sqrt((1+e['pan'])/2)]):
   for delay,gain in [(0,1),(.375*beat,.12),(.75*beat,.065)]:
    begin=start+round(delay*sr);values=v*pan*gain
    if loop:
     begin%=frames;n=min(len(values),frames-begin);stems[e['part']][begin:begin+n,c]+=values[:n]
     if n<len(values):stems[e['part']][:len(values)-n,c]+=values[n:]
    elif begin<frames:
     n=min(len(values),frames-begin);stems[e['part']][begin:begin+n,c]+=values[:n]
 mix=sum(stems.values());gain=min(.065/max(float(np.sqrt(np.mean(mix*mix))),1e-9),.6/max(float(np.max(np.abs(mix))),1e-9))
 for x in stems.values():
  x*=gain
  if not loop:
   x[:round(.04*sr)]*=np.linspace(0,1,round(.04*sr))[:,None]
   x[-sr*3:]*=np.linspace(1,0,sr*3)[:,None]
 mix=sum(stems.values());assert np.isfinite(mix).all() and np.max(np.abs(mix))<.7
 return mix,stems

def wav(path,x,sr):
 with wave.open(str(path),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes((x*32767).astype('<i2').tobytes())

def vlq(n):
 out=[n&127];n>>=7
 while n:out.insert(0,(n&127)|128);n>>=7
 return bytes(out)

def midi(path,s):
 tracks=[];tempo=round(60000000/s['bpm']);meta=b'\x00\xff\x51\x03'+tempo.to_bytes(3,'big')+b'\x00\xff\x58\x04\x04\x02\x18\x08'
 last=0
 for section in s['sections']:
  at=section['startBar']*4*480;label=section['section'].encode();meta+=vlq(at-last)+b'\xff\x06'+vlq(len(label))+label;last=at
 tracks.append(meta+b'\x00\xff\x2f\x00')
 for ch,part in enumerate(PARTS):
  events=[]
  for e in s['events']:
   if e['part']!=part:continue
   start=round(e['beat']*480);end=round((e['beat']+e['duration'])*480);vel=max(1,min(127,round(e['velocity']*600)))
   events.extend([(start,bytes([0x90+ch,e['note'],vel])),(end,bytes([0x80+ch,e['note'],0]))])
  events.sort(key=lambda e:(e[0],e[1][0]));body=b'\x00'+bytes([0xc0+ch,[4,38,89,10][ch]]);last=0
  for when,data in events:body+=vlq(when-last)+data;last=when
  tracks.append(body+b'\x00\xff\x2f\x00')
 path.write_bytes(b'MThd'+struct.pack('>IHHH',6,1,len(tracks),480)+b''.join(b'MTrk'+struct.pack('>I',len(t))+t for t in tracks))

manifest=json.loads((OUT/'manifest.json').read_text());manifest.update(version=2,status='complete first production version; listening acceptance pending');manifest['music']={};album=[]
for number,spec in enumerate(SPECS,1):
 name,zh,en,bpm,key,_,_=spec;folder=RELEASE/f'{number:02d}-{name}';folder.mkdir(exist_ok=True)
 loopscore=score(spec,False);ostscore=score(spec,True)
 for mode,s in [('loop',loopscore),('ost',ostscore)]:
  (ROOT/'audio/source'/f'{name}-{mode}.json').write_text(json.dumps(s,ensure_ascii=False,indent=2)+'\n');midi(folder/f'{name}-{mode}.mid',s)
 mix,_=render(loopscore,24000,True);wav(OUT/(name+'.wav'),mix,24000)
 row=dict(file=name+'.wav',title=zh,titleEn=en,bpm=bpm,key=key,bars=loopscore['bars'],beatsPerBar=4,sampleRate=24000,frames=len(mix),loopStart=0,loopEnd=len(mix),peak=float(np.max(np.abs(mix))),rms=float(np.sqrt(np.mean(mix*mix))),seam=float(np.max(np.abs(mix[-1]-mix[0]))),switchBars=list(range(0,32,4)))
 manifest['music'][name]=row
 master,stems=render(ostscore,48000,False);wav(folder/'master.wav',master,48000)
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(folder/'master.wav'),'-metadata',f'title={en}','-metadata','album=Phase & Presence','-metadata',f'track={number}','-c:a','flac',str(folder/'master.flac')],check=True)
 (folder/'stems').mkdir(exist_ok=True)
 for part,x in stems.items():wav(folder/'stems'/f'{part}.wav',x,48000)
 # Browser audition version has a deliberate start/end and no loop flag.
 subprocess.run(['ffmpeg','-v','error','-y','-i',str(folder/'master.wav'),'-c:a','libmp3lame','-b:a','160k',str(OUT/f'{name}-ost.mp3')],check=True)
 measurement=subprocess.run(['ffmpeg','-hide_banner','-i',str(folder/'master.wav'),'-af','loudnorm=I=-23:TP=-2:LRA=11:print_format=json','-f','null','-'],capture_output=True,text=True,check=True).stderr
 qc=json.JSONDecoder().raw_decode(measurement[measurement.rfind('{'):])[0];row['ostSeconds']=len(master)/48000;row['loudness']=qc
 assert float(qc['input_tp']) < -2
 album.append(dict(number=number,id=name,title=zh,titleEn=en,seconds=len(master)/48000,format='48000 Hz / 16-bit PCM + lossless FLAC',sections=ostscore['sections'],sha256=hashlib.sha256((folder/'master.flac').read_bytes()).hexdigest(),qc=qc))
 print(name,round(row['frames']/24000,1),'loop /',round(row['ostSeconds'],1),'OST seconds',flush=True)
manifest['album']=album;manifest_temp=OUT/'manifest.tmp.json'
manifest_temp.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');manifest_temp.replace(OUT/'manifest.json')
(RELEASE/'album.json').write_text(json.dumps(album,ensure_ascii=False,indent=2)+'\n')
credits='Phase & Presence — momo original instrumental soundtrack\nOriginal score and deterministic synthesis created for momo with Codex assistance. No sampled instruments, borrowed melodies or music-generation model.\nSix independently arranged 48-bar album versions; loop editions are 32 bars.\nSources: audio/source/album.py, editable JSON scores, MIDI; production process references in audio/RESEARCH.md.\n48kHz 16-bit PCM masters and FLAC encode the same samples. Stems sum to each master before quantization.\nNo public distribution platform release has been made.\n'
(RELEASE/'CREDITS.txt').write_text(credits)
with zipfile.ZipFile(RELEASE/'momo-phase-and-presence-ost.zip','w',zipfile.ZIP_DEFLATED,compresslevel=3) as z:
 for p in RELEASE.rglob('*'):
  if p.is_file() and p.suffix in ('.flac','.mid','.json','.txt'):z.write(p,p.relative_to(RELEASE))
print(RELEASE/'momo-phase-and-presence-ost.zip')
