# Music craft sources used for 014 / 015

Reviewed 2026-11-05. These guide decisions; they are not audio sources or libraries embedded in momo.

- [SJY051/music-composition](https://github.com/SJY051/music-composition), 105 GitHub stars at inspection. Read SKILL.md, navigation, game-music, motivic-development and arrangement-for-mix. Used a recognizable motif before transformation, contrasting sections/rests, circular loop-tail rendering, central bass and spacious sparse upper voices that leave dialogue room. General theory references, not proof of musical quality.
- [the0cp/beatflow-skill](https://github.com/the0cp/beatflow-skill), 27 stars at inspection, GPL-3.0-only. Read its SKILL.md as a workflow reference (explicit beat positions, structure and deterministic note exports). Did **not** install, execute, copy its implementation or include the engine. Our MIDI writer is local Standard MIDI serialization. Popularity is low, so this was not treated as an authoritative quality benchmark.
- Also inspected GitHub search results for jtydhr88/music-composition-skills and sb-dev/music-production-skills; not used as executable tooling.

No music-generation model, sample pack, reference melody or copyrighted recording was used. Existing approved D–A–E–F# motif stays recognizable; alternate phrases, modal center and arrangement density vary by scene. Runtime synthesis is deliberately absent.

Album arrangement: 4-bar intro → 8-bar theme → 8-bar answer → 8-bar development bridge → 12-bar expanded return → 8-bar coda. Loop editions: 8-bar theme → 8-bar answer → 8-bar breath → 8-bar return. These are separate score constructions, not concatenated loop files.

Mix: synthesis at 48 kHz for album masters and 24 kHz for game PCM, fixed per-track gain to RMS 0.065 with peak cap 0.6, ffmpeg integrated loudness/true peak measurement retained in manifest. No claim that numerical checks substitute for hearing the music.
