# Computer runtime: implementation and acceptance boundary

Updated 2026-11-05. Plans 006/007/008 remain **in progress**, not accepted or done.

## Shared observation and reasoning

Selected screen capture is explicit browser screen sharing. Only the latest normalized frame stays in memory, with 15-second expiry and erase on revoke. Capture requires Boot, verified current vision configuration and shared attention. Source/generation/age are checked again before provider submission. The current bounded session stops after 120 frames or ten minutes; proactive analyses have a 12-turn cap and 30-second cooldown.

Ordinary chat uses `screen_observe`; actual pixels are projected once into the private provider request, never serialized into transcript or compact state. Proactive reactions use the normal chat SSE, history, persona, sentence performance/TTS and display acknowledgement. They do not create a fictitious player message. Only source/time metadata is recorded for the observation trigger. Screen text cannot grant actions. The former standalone inference endpoints return 410.

Native desktop overlay, continuous background capture and general host-desktop keyboard/mouse execution are not implemented. Browser tab suspension remains a limitation of the Web capture slice. No changes have been promoted to the desktop repository.

## Browser: restricted page snapshots

Cordis owns a prepared Docker browser instance. Python owns model reasoning, grants and attention. The container has no network, user-directory mounts, published ports or Docker socket; it runs as UID 65534 with read-only root, bounded tmpfs/CPU/memory/PIDs and dropped capabilities. JavaScript is disabled. Chromium's internal sandbox is disabled inside this constrained container; the container/VM boundary is the experimental isolation boundary, not a completed security audit.

The host supports screenshots, bounded HTML loading, clicks, typing and scrolling. A bounded accessibility snapshot exposes named elements for semantic click/fill; opaque element IDs expire with the observation version and are cleared after every command. Actions require current server-issued permits and fresh screenshot versions. Shared revoke waits for container removal acknowledgement. Actual fixture tests verified screenshots, input, stale/revoked rejection and cleanup, including the integrated Cordis path.

Settings exposes exact website host grants and optional page interaction. `browser_open` performs bounded public HTTPS GET through a separate fetch service: public DNS answers only, pinned destination IP with original-host TLS validation, exact-host checks on every redirect, no cookies, credentials, environment proxy, uploads or POST. Fetch occurs outside the stop barrier, with grant checks before and after network work. HTML/text is rendered in the offline container. The model receives actual transient screenshots through the same multimodal projection as screen observation.

This is **not a full online browser**: authenticated sites, script-heavy pages, remote form submission and cross-site resource loading are unsupported. No claim that GET itself guarantees absence of server-side effects. Automatic environment installation/packaging and general computer-use execution remain unfinished. The current development runtime needs a prepared image and Docker Desktop; this prerequisite must be removed or product-managed before release.

Build evidence: prepared image `sha256:a7498c83e3e118f973d5023fd374a3abbf917ceb80298f97164ada10fed37f08`; opt-in real container tests passed. The digest-pinned base and signed Debian package metadata are recorded in the resource Dockerfile. Runtime never downloads resources automatically.

## Minecraft

Original Fabric 1.21.1 component compiles, including remapJar. First-person frames and visible state cross an authenticated localhost bridge. Cordis owns configure/observe/chat/follow/stop; Python enforces grants, current visual model, shared attention and bounded commands. Follow is a short deterministic straight-line action, requires fresh observation, and is not a full pathfinder. Pixels are stripped from tool JSON and projected transiently.

Official resource preparation and qualification succeeded on macOS arm64 (3,963 files, 72 classpath jars, 3,888 assets). Dedicated-instance preparation, Java21 selection, managed device-code login and entitlement/profile validation, private refresh storage and launch are implemented. Settings automatically polls login and process status. Launch uses a private argument file and supervisor-owned lifetime pipe; backend crash closes the pipe and reclaims the child. Startup can be cancelled before spawn or during readiness.

No live Microsoft login or graphical client/private-world acceptance has occurred. It still requires momo's registered public-client ID; other launchers' client IDs are not substituted. Launch opens the game menu; the player joins the explicitly allowed server manually. Robust pathfinding and product resource packaging remain outstanding. See `minecraft-resources.md`.
