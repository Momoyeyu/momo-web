# Local time, room lighting and General settings

2026-11-05: player reported momo treating ~17:30 in China as before dawn. Investigation found a fresh per-turn clock, but only UTC plus ambiguous `CST+08:00` were provided; the model had to perform the conversion. We cannot prove which internal inference caused that reply. Fixed the representation rather than assuming the clock itself was stale.

`core/time.py` now supplies host-local ISO time, an explicit 24-hour date/time, unambiguous UTC offset and local time-of-day. `common_time` shares that implementation; the late per-turn system anchor instructs the model to use the fresh clock, not historical time claims or remembered timezone. UTC remains supplemental in tool results. No timezone is inferred from UI language or remembered facts. Web is local-host only: backend host and player computer coincide; future remotely hosted deployment needs a validated client-zone contract. External contacts are not assumed to share the host's location. Transient time stays outside compacted history.

Room lighting uses the frontend computer's local clock; morning/day/evening/night are explicit artistic intervals in `roomTime.ts`. Three original-room imagegen edits plus the existing day image, 1.4 s decoded crossfade, reduced-motion support, focus/resume clock checks. No move/location system. See `frontend/public/stage/README.md` for provenance and exact intervals.

General layout: full-width compact language row; equal-width sound and dialogue cards below; backup remains full-width. Voice, SFX, BGM and palette controls are direct, not in a nested modal. Dialogue preview follows its controls, eliminating the old large elastic gap. zh/en/ja sound heading renamed. Existing voice gating and persistence remain.

Validation: frontend unit tests/build, backend local-time and per-turn freshness tests; real-browser three-language 1280×720 settings and four-period room screenshots. Background transitions retain one Live2D canvas. No claims that explicit clock context can prevent every model reasoning error.
