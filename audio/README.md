# Phase & Presence — momo original audio (014 / 015)

Six instrumental compositions share a D–A–E–F# motif, with distinct tempos, harmony, density and melodic development. All notes and synthesis are authored in this repository. No external samples or music-generation model. Composition guidance and source distinctions: [RESEARCH.md](RESEARCH.md).

| Track | Situation | BPM | Game loop | OST |
|---|---|---:|---:|---:|
| 待机心跳 / Standby Heart | title | 76 | 101 s | 156 s |
| 初次连接 / First Connection | intro | 76 | 101 s | 156 s |
| 同频日常 / In Phase | daily | 84 | 91 s | 141 s |
| 夜间微光 / Afterglow | late night / quiet | 64 | 120 s | 184 s |
| 小小跃迁 / Quantum Hop | stable bright mood | 96 | 80 s | 124 s |
| 留在这里 / Stay Here | comfort | 68 | 113 s | 173 s |

Game versions: 32 bars (theme, answer, breath, return), circular note/delay tails, 24 kHz / 16-bit stereo PCM. OST versions: independently arranged 48 bars (intro, theme, answer, bridge, expanded return, coda) plus decay, 48 kHz / 16-bit WAV and lossless FLAC. Browser MP3 editions are for audition only, not runtime loops. Four genuine synthesized stems (keys, bass, air, spark) sum to each master before quantization. MIDI includes tempo, section markers and four suggested GM instrument tracks; GM playback differs from the authored synthesizer.

Warm and glass palettes each supply eleven semantic effects: tap, confirm, cancel, on/off, phone in/out, boot, home, completion, notification. No hover, typing or slider-tick noise.

## Reproduce / listen

Requires Python 3, numpy and ffmpeg on PATH:

```sh
backend/.venv/bin/python audio/source/album.py
backend/.venv/bin/python audio/source/check.py
```

Open `/audio/listen.html` on the running Web service for all six loop/OST pairs and both palettes. JSON scores live alongside the renderer. `.workbuddy/audio-release/` holds WAV/FLAC masters, MIDI, individual stems, credits and `momo-phase-and-presence-ost.zip` (FLAC, MIDI, album metadata, credits). Sources/scores/runtime audio are versioned; reproducible bulky production files are not committed.

`quality.json` records sample peak, DC/finite checks, three-loop boundary checks against local sample derivatives, stem reconstruction, FLAC hash and ffmpeg loudness measurements. OST integrated loudness is −22.12 to −21.57 LUFS; true peak −9.81 to −8.36 dBTP. Measurement does not certify subjective listening quality. Full production version accepted by the user on 2026-11-06; no external album publication has occurred.
