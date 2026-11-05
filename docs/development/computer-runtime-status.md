# Computer runtime: implementation and acceptance boundary

Updated 2026-11-05. Plans 006/007/008 remain **in progress**, not accepted or done.

## Shared observation and reasoning

Selected screen capture is explicit browser screen sharing. Only the latest normalized frame stays in memory, with 15-second expiry and erase on revoke. Capture requires Boot, verified current vision configuration and shared attention. Source/generation/age are checked again before provider submission. The current bounded session stops after 120 frames or ten minutes; proactive analyses have a 12-turn cap and 30-second cooldown.

Ordinary chat uses `screen_observe`; actual pixels are projected once into the private provider request, never serialized into transcript or compact state. Proactive reactions use the normal chat SSE, history, persona, sentence performance/TTS and display acknowledgement. They do not create a fictitious player message. Only source/time metadata is recorded for the observation trigger. Screen text cannot grant actions. The former standalone inference endpoints return 410.

Native bounded application observation/input is now implemented through the fixed helper; real input remains unverified without Accessibility permission. Native desktop overlay and continuous background capture remain incomplete. Browser tab suspension remains a limitation of the Web scheduling slice. No changes have been promoted to the desktop repository.

## Browser: existing approved application

The isolated Docker renderer has been retired and removed. No new Chromium process/profile is created. Browser interaction uses the same selected-window native broker as desktop interaction. Legacy browser start/action requests fail explicitly; old stop remains harmless for cleanup compatibility.

Application approval is not OS isolation: clicking in the user's browser can affect the user's real session. The broker binds bundle ID/path/PID/window, requires fresh observations and checks foreground/bounds before input. No shell, URL opener, arbitrary code or launch command is exposed. Future DOM semantics must attach to an explicitly approved existing session; this version uses visual interaction and does not claim DOM support.

## Minecraft

Fabric 1.21.1 component builds and publishes a private0600 rendezvous for an existing client. Settings discovers and attaches the selected current account/world; it neither authenticates a second account nor launches a client. Bounded obstacle navigation replaces straight-line following, with four Java smoke cases. Stop releases controls without closing the player's game.

The earlier independent login/resource/client approach has been removed after the user's correction. Existing-client attachment transport tests pass; actual gameplay smoke still needs a user-selected compatible Fabric instance with the mod installed. No existing launcher credentials or worlds have been read or modified. See `minecraft-resources.md` and `minecraft-smoke-20261105.md`.
