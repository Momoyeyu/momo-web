# momo original audio — 014 / 015 listening draft

Render with `backend/.venv/bin/python audio/source/render.py` (numpy 2.5.4, Python 3). All oscillators, melodies, harmony and envelopes are authored here; no external samples, generated-model music or borrowed melody. Source is governed by the repository license. This is not a mastered OST release.

The four-note D–A–E–F# motif connects two 16-bar sketches: title (76 BPM, 50.53 s) and daily (84 BPM, 45.71 s). Each has a second eight-bar variation. Circular additive rendering folds decay/delay tails into the next loop. The JSON scores retain notes, beat positions, durations, velocity and pan; stems are reproducibly generated under `.workbuddy/audio-stems/` without shipping stems in the game.

Runtime WAVs use 24 kHz PCM, 16-bit stereo for music / mono for short effects. These are compact listening masters, not final 48 kHz OST masters. `manifest.json` provides source frames, loop boundaries, BPM, key and basic peak/RMS checks. Final loudness, arrangement and device listening need approval. The full album (development, intros/outros, credits, lossless release) remains in 015 and is not claimed complete.

Ten semantic effects have warm/glass variants; no hover or keystroke effects. Common motif intervals and paired up/down gestures accompany confirm, toggle, phone, Boot and Home. First-step sound palette choice precedes final production, as required by 014/015.
