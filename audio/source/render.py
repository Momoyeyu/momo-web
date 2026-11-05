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

manifest=json.loads((OUT/'manifest.json').read_text()) if (OUT/'manifest.json').exists() else {'version':1,'music':{}}
manifest['sfx']={}
sequences={'tap':[74],'confirm':[74,78],'cancel':[74,69],'on':[69,74],'off':[74,69],'phone-in':[62,69,74],'phone-out':[74,69,62],'boot':[62,69,74,78],'home':[78,74,69,62],'complete':[69,74,78,81],'notify':[74,78]}
for style,shift in [('warm',0),('glass',12)]:
 for name,notes in sequences.items():
  gap=.035 if len(notes)<3 else .055; duration=.075 if name=='tap' else .16; length=duration+gap*(len(notes)-1);x=np.zeros(round(length*SR))
  for i,n in enumerate(notes):
   v=tone(n+shift,duration,.12 if style=='warm' else .075,True);start=round(i*gap*SR);x[start:start+len(v)]+=v[:len(x)-start]
  manifest['sfx'][style+'/'+name]=write(style+'-'+name,x)
manifest_temp=OUT/'manifest.tmp.json'
manifest_temp.write_text(json.dumps(manifest,indent=2)+'\n');manifest_temp.replace(OUT/'manifest.json')


# Combined A/B audition reels, with silence between semantic events.
for style in ['warm','glass']:
 parts=[]
 for name in ['confirm','on','off','phone-in','phone-out','boot','complete']:
  with wave.open(str(OUT/f'{style}-{name}.wav')) as w:parts.append(w.readframes(w.getnframes()))
  parts.append(bytes(SR))
 with wave.open(str(OUT/f'{style}-preview.wav'),'wb') as w:
  w.setnchannels(1);w.setsampwidth(2);w.setframerate(SR);w.writeframes(b''.join(parts))
