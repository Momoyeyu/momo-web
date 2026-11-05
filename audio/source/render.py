"""Original momo sketches, deterministic additive synthesis. Requires numpy.
No samples, downloaded sounds, model inference or third-party melodies.
Run: backend/.venv/bin/python audio/source/render.py
"""
from pathlib import Path
import json, wave
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'frontend/public/audio'; OUT.mkdir(parents=True,exist_ok=True)
SR=24000

def tone(note, duration, velocity=.16, bell=False):
 t=np.arange(round(duration*SR))/SR; f=440*2**((note-69)/12)
 env=(1-np.exp(-t/0.009))*np.exp(-t/(.35 if bell else .9))
 env*=np.minimum(1,(duration-t)/.06)
 x=np.sin(2*np.pi*f*t + .22*np.sin(2*np.pi*f*2*t)*np.exp(-t*5))
 x+=.16*np.sin(2*np.pi*f*2*t)*np.exp(-t*3)
 return x*env*velocity

def write(name,x):
 x=np.asarray(x);x=x-np.mean(x,axis=0)
 assert np.max(np.abs(x))<.98 and np.isfinite(x).all()
 with wave.open(str(OUT/(name+'.wav')),'wb') as w:
  w.setnchannels(1 if x.ndim==1 else 2);w.setsampwidth(2);w.setframerate(SR);w.writeframes((x*32767).astype('<i2').tobytes())
 return dict(file=name+'.wav',frames=len(x),sampleRate=SR,peak=round(float(np.max(np.abs(x))),5),rms=round(float(np.sqrt(np.mean(x*x))),5))

manifest={'version':1,'status':'original listening drafts; not mastered OST','sfx':{},'music':{}}
sequences={'confirm':[74,78],'cancel':[74,69],'on':[69,74],'off':[74,69],'phone-in':[62,69,74],'phone-out':[74,69,62],'boot':[62,69,74,78],'home':[78,74,69,62],'complete':[69,74,78,81],'notify':[74,78]}
for style,shift in [('warm',0),('glass',12)]:
 for name,notes in sequences.items():
  gap=.035 if len(notes)<3 else .055; length=.16+gap*(len(notes)-1);x=np.zeros(round(length*SR))
  for i,n in enumerate(notes):
   v=tone(n+shift,.16,.12 if style=='warm' else .075,True);start=round(i*gap*SR);x[start:start+len(v)]+=v[:len(x)-start]
  manifest['sfx'][style+'/'+name]=write(style+'-'+name,x)
# A shared D-A-E-F# motif, in D major/add9 harmony; two deliberate eight-bar sketches.
# Scores are retained as editable event lists, rather than arbitrary runtime notes.
for name,bpm,chords in [('title',76,[[50,57,61,66],[47,54,59,62],[43,50,57,62],[45,52,57,61]]),('daily',84,[[50,57,61,66],[54,57,61,69],[43,50,57,62],[45,52,59,64]])]:
 beat=60/bpm;length=beat*64;frames=round(length*SR)
 stems={k:np.zeros((frames,2)) for k in ('keys','pulse','air')};score=[]
 def add(part,n,at,duration,vel,pan=0):
  score.append(dict(part=part,note=n,beat=at,duration=duration,velocity=vel,pan=pan))
  v=tone(n,duration*beat,vel);start=round(at*beat*SR);idx=(np.arange(len(v))+start)%frames
  for c,g in enumerate([np.sqrt((1-pan)/2),np.sqrt((1+pan)/2)]):
   np.add.at(stems[part][:,c],idx,v*g)
   # Circular delay carries the tail across the loop boundary.
   np.add.at(stems[part][:,c],(idx+round(.375*beat*SR))%frames,v*g*.16)
 for bar in range(16):
  chord=chords[(bar//2)%4];base=bar*4
  for n in chord:add('air',n,base,5,.035)
  add('pulse',chord[0]-12,base,1.8,.11)
  if bar%2==0:add('pulse',chord[0]-12,base+.65,1,.055)
  motif=[74,69,76,78] if bar<8 else [78,76,81,74]
  if name=='daily':motif=[n-12 for n in motif]
  for j,n in enumerate(motif):
   if bar%4==3 and j>1:continue
   add('keys',n,base+j*.875,2.1,.12 if j==0 else .085,(-.18 if j%2 else .18))
 mix=sum(stems.values());peak=np.max(np.abs(mix));mix*=.42/max(.42,peak)
 manifest['music'][name]={**write(name,mix),'bpm':bpm,'beatsPerBar':4,'loopStart':0,'loopEnd':frames,'key':'D major','bars':16}
 (ROOT/'audio/source'/f'{name}-score.json').write_text(json.dumps(score,indent=2)+'\n')
 # Source stems reproducible on demand; excluded runtime distribution.
 stemdir=ROOT/'.workbuddy/audio-stems'/name;stemdir.mkdir(parents=True,exist_ok=True)
 for part,x in stems.items():
  with wave.open(str(stemdir/(part+'.wav')),'wb') as w:w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes((x*32767).astype('<i2').tobytes())
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({k:{'seconds':v['frames']/SR,'peak':v['peak'],'seam': 'circular synthesis'} for k,v in manifest['music'].items()},indent=2))

# Combined A/B audition reels, with silence between semantic events.
for style in ['warm','glass']:
 parts=[]
 for name in ['confirm','on','off','phone-in','phone-out','boot','complete']:
  with wave.open(str(OUT/f'{style}-{name}.wav')) as w:parts.append(w.readframes(w.getnframes()))
  parts.append(bytes(SR))
 with wave.open(str(OUT/f'{style}-preview.wav'),'wb') as w:
  w.setnchannels(1);w.setsampwidth(2);w.setframerate(SR);w.writeframes(b''.join(parts))
