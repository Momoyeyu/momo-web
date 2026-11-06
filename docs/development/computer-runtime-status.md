# Computer runtime: implementation and acceptance boundary

Updated 2026-11-06. Plans 006/007/008 remain **in progress**, not accepted or done.

## Shared observation and reasoning

Selected screen capture is explicit browser screen sharing. Only the latest normalized frame stays in memory, with 15-second expiry and erase on revoke. Capture requires Boot, verified current vision configuration and shared attention. Source/generation/age are checked again before provider submission. The current bounded session stops after 120 frames or ten minutes; proactive analyses have a 12-turn cap and 30-second cooldown.

Ordinary chat uses `screen_observe`; actual pixels are projected once into the private provider request, never serialized into transcript or compact state. Proactive reactions use the normal chat SSE, history, persona, sentence performance/TTS and display acknowledgement. They do not create a fictitious player message. Only source/time metadata is recorded for the observation trigger. Screen text cannot grant actions. The former standalone inference endpoints return 410.

Native bounded application observation/input uses the fixed helper. Desktop migration is active under plan 017. The current batch adds a transparent always-on-top mode to the **same** Electron window, renderer, avatar and conversation; Chat has a direct desktop/return entry. Click-through is recoverable from the menu bar, Dock or shortcut. Entering this presentation mode does not grant observation or input. Native transparent presentation and real input still require the final packaged smoke; browser fixtures do not prove OS behavior.

Plugin settings share QQ's compact card hierarchy. The Chat activity panel directly hosts window/game selection, start and stop instead of repeating settings cards. Rare configuration and allowlist maintenance remain in settings. The sound plans 014/015 are accepted; preview now shares the sound-style row.

The batch keeps the installed application unchanged until code, isolated checks and review converge. It will be promoted, packaged and installed together to avoid repeated ad-hoc-signature permission invalidation.

Before taking model-requested pixels, context preparation reserves a square upper bound and selects a 1536, 1024 or 512-pixel maximum edge to fit the configured model window. Resizing a selected application cannot invalidate that reservation. Proactive observations can be downsampled without renewing their original 15-second deadline. Actions use the exact returned image dimensions, mapped to the authorized window's logical coordinates; stale, non-finite and out-of-bounds coordinates are rejected. A once-only grant's five-minute execution window begins on approval, separately from the pending request's expiry. Stop revokes pending requests and failed native stop remains visibly retryable.

## Browser: existing approved application

The isolated Docker renderer has been retired and removed. No new Chromium process/profile is created. Browser interaction uses the same selected-window native broker as desktop interaction. Legacy browser start/action requests fail explicitly; old stop remains harmless for cleanup compatibility.

Application approval is not OS isolation: clicking in the user's browser can affect the user's real session. The broker binds bundle ID/path/PID/window, requires fresh observations and checks foreground/bounds before input. No shell, URL opener, arbitrary code or launch command is exposed. Future DOM semantics must attach to an explicitly approved existing session; this version uses visual interaction and does not claim DOM support.

## Minecraft

Fabric 1.21.1 component builds and publishes a private0600 rendezvous for an existing client. Settings discovers and attaches the selected current account/world; it neither authenticates a second account nor launches a client. Bounded obstacle navigation replaces straight-line following, with four Java smoke cases. Stop releases controls without closing the player's game.

The earlier independent login/resource/client approach has been removed after the user's correction. Existing-client attachment transport tests pass; actual gameplay smoke still needs a user-selected compatible Fabric instance with the mod installed. No existing launcher credentials or worlds have been read or modified. See `minecraft-resources.md` and `minecraft-smoke-20261105.md`.

## Verification and remaining decisions (2026-11-06)

- Isolated UI: native approval once/always/deny; server-owned resume; observation survives Settings/Chat; existing Minecraft attach/stop; direct activity controls; same-renderer pet/return. Three languages and 1280×720 / 1920×1080 extension lists checked.
- This batch's checks: 119 focused backend tests; 248 frontend unit tests and TypeScript; browser approval, stop retry, activity tabs, Minecraft attachment, desktop-mode continuity, three-language extension pagination and inline sound preview. These use isolated profiles and fixtures; they do not stand in for native permission or real gameplay acceptance.
- No live application input or player-world changes were performed during this batch. Real native smoke remains pending the final package.
- Existing Fabric integration targets 1.21.1. The user's standard Minecraft directory currently contains 1.21.4/1.21.5; actual instance/loading framework confirmation is pending. Do not silently install another client/account.
- A browser tablet is a design proposal awaiting user confirmation, not implemented scope. Existing approved-browser control remains the executor.
