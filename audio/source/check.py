"""Offline technical acceptance, not subjective musical-quality scoring."""
import json,wave,struct,hashlib
from pathlib import Path
import numpy as np
root=Path(__file__).resolve().parents[2];out=root/'frontend/public/audio';release=root/'.workbuddy/audio-release'
m=json.loads((out/'manifest.json').read_text());assert len(m['music'])==6
report={}
for id,t in m['music'].items():
 with wave.open(str(out/t['file'])) as w:
  assert w.getframerate()==t['sampleRate'] and w.getnframes()==t['frames']
  x=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').reshape(-1,2)/32768
 assert np.isfinite(x).all() and np.max(np.abs(x))<.7 and np.max(np.abs(x.mean(0)))<.001
 assert 75<len(x)/t['sampleRate']<=125
 # Three repetitions must not introduce a discontinuity beyond normal adjacent samples.
 seam=np.max(np.abs(x[-1]-x[0]))
 local=np.concatenate((np.diff(x[-2400:],axis=0),np.diff(x[:2400],axis=0)))
 limit=max(.003,float(np.quantile(np.abs(local),.99))*2)
 assert seam<=limit,(id,seam,limit)
 triple=np.tile(x,(3,1))
 for index in (len(x),2*len(x)):assert np.max(np.abs(triple[index]-triple[index-1]))<=limit
 folder=next(release.glob('*-'+id));album=next(a for a in m['album'] if a['id']==id)
 assert hashlib.sha256((folder/'master.flac').read_bytes()).hexdigest()==album['sha256']
 assert float(album['qc']['input_tp'])<-2
 for mode,bars in [('loop',32),('ost',48)]:
  score=json.loads((root/'audio/source'/f'{id}-{mode}.json').read_text());assert score['bars']==bars
  assert sum(s['bars'] for s in score['sections'])==bars
  assert all(0<=e['beat']<bars*4 and 0<=e['note']<=127 for e in score['events'])
  data=(folder/f'{id}-{mode}.mid').read_bytes();assert data[:4]==b'MThd' and struct.unpack('>H',data[10:12])[0]==5
 with wave.open(str(folder/'master.wav')) as w:master=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(np.int32)
 summed=np.zeros_like(master)
 for path in (folder/'stems').glob('*.wav'):
  with wave.open(str(path)) as w:summed+=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(np.int32)
 assert np.max(np.abs(summed-master))<=4
 assert np.max(np.abs(master[-96000:]))<1000
 report[id]={'seconds':len(x)/t['sampleRate'],'seam':float(seam),'localDerivativeLimit':limit,'peak':float(np.max(np.abs(x))),'threeLoopBoundaryCheck':True,'stemsReconstructMaster':True,'integratedLUFS':album['qc']['input_i'],'truePeak':album['qc']['input_tp']}
for id,t in m['sfx'].items():
 with wave.open(str(out/t['file'])) as w:x=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2')/32768
 assert len(x)>100 and np.max(np.abs(x))<.9 and abs(x.mean())<.001
(out/'quality.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
